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
| subinterface | `Hostname(config-subif)#` | `interface <port>.<n>` (from config, or from another interface) |
| dhcp pool | `Hostname(dhcp-config)#` | `ip dhcp pool <name>` (from config) |

## Global / exec commands

| Command | Effect |
|---------|--------|
| `enable` | enter enable mode |
| `configure terminal` | enter config mode, answering with the box's one-line greeting; abbreviable word by word, down to what is still unique - `config t` is accepted, `con` is refused as ambiguous (`configure` / `converge`), and a bare `configure` is `% Incomplete command` |
| `show version` | vendor, model, category, capabilities |
| `show ip interface brief` | interface IP / status table (status = whether the port can carry a frame), one row per **data** port, one per subinterface directly under the port it rides on (`GigabitEthernet0/0/0`, then `GigabitEthernet0/0/0.10`, before the next socket - `research/interface-brief-subinterface-order.md`), and one per EtherChannel bundle (`Port-channel1`, `unassigned YES unset`, `up` only when a member is in it); a console or aux socket is a line, not an interface, and has no row (`research/console-is-a-line-not-an-interface.md`) |
| `show ip interface [<port>]` | the per-port detail block `show interfaces` prints, for one port when a port is named - the box's IP view (`show ip interface [type number] [brief]`) is this console's interface view, since no separate IP-characteristics block is modelled; `brief` keeps its own table (`research/show-ip-interface-port-form.md`) |
| `show ip route` | routing table: connected, static, OSPF, BGP, and the default - or `Gateway of last resort is not set` when there is none; a box that does not route prints `Default gateway is ...` over the host/redirect cache instead |
| `show arp` | ARP cache: the neighbours it has heard, with an age and the port each was heard on and whether that port can still carry a frame, plus a local row (age `-`) for every interface holding an IPv4 address |
| `show mac address-table` | MAC table (switches), per VLAN, with an age per entry and stale entries marked, the box's twenty reserved `All … CPU` rows above the learned ones, titled and ruled as the device prints it and closed by `Total Mac Addresses for this criterion: N`; an address learned through a bundle is named on the port-channel (`Po1`), as the device names it (`research/mac-table-port-channel-name.md`) |
| `show vlan` / `show vlan brief` | VLAN table: one row per VLAN in the VLAN database, with the **access** ports in it - a trunk port carries the VLAN and appears in no row - and the four reserved defaults (1002-1005) a switch has from boot. `show vlan` is the full view: it then prints the media table (`Type`, `SAID`, `MTU`, `Stp`, `Trans1/2`), the empty `Remote SPAN VLANs` section and the empty private-VLAN table; `brief` stops after the first table |
| `show spanning-tree` | per-port STP role, state and path cost in the table's own cells (`Root`/`Desg`/`Altn`, `FWD`/`BLK`/`LTN`/`LRN`, the short-method `Cost`), the bridge priority and the elected root, or "not measured" when nothing has run; the detail view's `alternate blocking` sentence is the payload's tooltip wording, not a cell (`research/stp-port-table-role-and-sts.md`, `research/stp-port-table-cost-column.md`) |
| `show etherchannel summary` | the device's own summary: the nine-line flag key, both counts, `Po<N>(SU)` per group, LAG members `(P)` bundled, `(I)` stand-alone or `(D)` unbundled, with the reason; a channel-group number in front of the keyword keeps that group's row only, and leaves both counts as the box's totals |
| `show lldp` | the protocol's status block: `Global LLDP Information:` with `Status: ACTIVE`, the 30 s advertisement interval, the 120 s hold time it advertises and the 2 s reinitialisation delay - the four lines a Catalyst prints, so "running with nothing heard" is distinguishable from "off", which only `show lldp neighbors` used to look like |
| `show lldp neighbors` | LLDP neighbours, with the local port marked when it can no longer carry, and each row listed only for as long as the hold time its neighbour advertised |
| `show access-lists` | ACL rules, bindings, and how many packets each rule has matched |
| `show ip bgp` / `show ip bgp summary` | BGP neighbours with their state (or the prefixes they sent) and reason, and the prefixes installed |
| `show ip ospf` / `show ip ospf neighbour` / `show ip ospf interface` | the process this box runs (`Areas`, `Interfaces`, `Neighbours`, `Routes installed from OSPF`), each adjacency's `Pri`, `State` and `Dead Time` - the Router Dead Interval counting down from that neighbour's last Hello - and what each port costs; a box with no OSPF says so and names the command that would turn it on |
| `show ip dhcp` / `show ip dhcp binding` / `show ip dhcp pool` | the allocation table under the box's own `Bindings from all pools not associated with VRF:` title: which MAC holds which address, from which pool, and how long is left on the lease - and, per pool, its utilisation mark, its totals and the address it would hand out next; a box with no pools says it is not a DHCP server |
| `show ip dns` / `show ip dns zone` | the zones this box answers for, as records in zone-file shape, and the name servers it asks; a zone it would refuse to answer is printed with `NOT answered: <reason>` rather than as if it were live, and a device with no zones says it is not a DNS server |
| `show interfaces` | per-interface detail incl. MAC, peer, link state and what has crossed the port; a console or aux socket is not an interface and gets no block - naming one answers in a sentence saying what it is |
| `show power inline [<port>]` | PoE supplied per PSE port, the box's `Available:/Used:/Remaining:` budget line above the table, and why a powered device was denied |
| `show vrrp` | the group, its state (`Master`/`Backup`/`Init` with the reason), and the master the election chose |
| `show running-config` | full configuration |
| `ping <ip> [count]` | ICMP echo from this device |
| `traceroute <address|name>` (`tracert`) | TTL-limited probes, one hop at a time, **three probes per hop**; each router that expires a probe answers with ICMP time exceeded, the destination with an echo reply, and every hop prints its address and a round trip per probe in `msec`; a probe refused with an ICMP destination-unreachable prints the letter for its code in that probe's column (`!N` network, `!H` host, `!P` protocol, `!U` port, `!A` administratively prohibited); a hop stopped by a down cable, a shut port or an ACL says why and ends the walk |
| `exit` / `logout` | leave the session |

`configure terminal` answers with the one sentence a box prints on entering config mode - `Enter configuration
commands, one per line.  End with CNTL/Z.` - and prints it once per entry: the config commands that follow and
the submodes they open print nothing of the sort, `end` prints nothing, and a refused `configure` enters no mode
and so prints no sentence. It is **one line**, and the **two spaces** after `line.` are the box's own: Cisco's
HTML pages collapse the run of spaces (and two editions wrap the sentence onto a second line in the rendered
block), while the PDF's Courier text layer keeps both. Evidence and the two questions left open - wrapping at a
narrow `terminal width`, and the NX-OS/IOS XR spellings - are in
[research/config-mode-greeting.md](../research/config-mode-greeting.md).

## A command word can be shortened, down to what is still unique

`sh ver` is `show version`, `sh int` is `show interfaces`, `conf t` is `configure terminal`. IOS accepts an
abbreviation of a command word "to the number of characters that allow a unique abbreviation", and this console
follows that rule at every place where it holds a complete list of the words that may appear there: the **first
word** of a line, the **view word after `show`**, the **first word of a config line** (with the word after `do`
resolved as the EXEC word it is), inside an interface block the **first word and the keyword after it**, and inside
a DHCP pool block the **first word and the word after `no`**.

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
| `ip add 10.0.0.1 255.255.255.0` | `ip address 10.0.0.1 255.255.255.0` |
| `desc uplink`, `de uplink` | `description uplink` |
| `sw mo acc`, `sw mo t` | `switchport mode access`, `switchport mode trunk` |
| `sw ac vlan 20` | `switchport access vlan 20` |
| `shut`, `no shut` | `shutdown`, `no shutdown` |
| `encap dot1q 10`, `cl rate 64000` | `encapsulation dot1q 10`, `clock rate 64000` |
| `ip o cost 10`, `ip ac 101 in` | `ip ospf cost 10`, `ip access-group 101 in` |
| `no ip add` | `no ip address` |
| `net 10.0.0.0 255.0.0.0`, `def 10.0.0.1` | `network 10.0.0.0 255.0.0.0`, `default-router 10.0.0.1` |
| `dns 8.8.8.8`, `rang 10.0.0.100 10.0.0.110` | `dns-server 8.8.8.8`, `range 10.0.0.100 10.0.0.110` |
| `lea inf`, `ho 10.0.0.5 aa:bb:cc:00:00:05` | `lease infinite`, `host 10.0.0.5 aa:bb:cc:00:00:05` |
| `no lea`, `no po`, `exi` | `no lease`, `no pool`, `exit` |
| `sh vlan br` | `show vlan brief` |
| `sh lldp nei` | `show lldp neighbors` |
| `sh ether summ` | `show etherchannel summary` |
| `sh ip interface br` | `show ip interface brief` |

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

Inside an interface block the same sentence names the words `(config-if)#` has - `no s` is
`shutdown | switchport | speed`, `ip a` is `address | access-group`, `d` is `description | duplex`:

```
sw1(config-if)#no s
% Ambiguous interface command "no s": shutdown | switchport | speed (type more characters)
```

A prefix that is ambiguous changes no state: `e` at `(config)#` does not leave config mode, it says which doors it
could have opened, and `no s` at `(config-if)#` neither closes the port nor switches anything. The pool block is
the same rule with its own vocabulary - `e` there is `excluded-address | exit | end`, `n` is `network | no`, and
`h` is `host | help`:

```
r1(dhcp-config)#e
% Ambiguous DHCP pool command "e": excluded-address | exit | end (type more characters)
```

The rule stops where this console has no complete list of the words that could appear. The words after `show ip`
are not shortened - type `show ip interface brief` in full; `sh ip int br` is refused as an unknown view - nor is a
value such as a port name: `sh int Fa` names no port rather than guessing one. A *tail* keyword is shortened where
the vendor's own syntax for that slot lists nothing else beginning with the same letters - `show vlan br`,
`show lldp nei`, `show etherchannel summ` and `show ip interface br` print, line for line, what the whole spelling
prints - while the positions where an image may hold a rival keep their refusal: a shortened `mac` tail (`mac add`)
is accepted on one image and `% Ambiguous command` on another, and the word after `show ip` is `interface` on a
switch but `interface | inspect` on a router. `research/show-tail-abbreviation.md` has the captures, the four slots and the boundary. The **second** word of a config line is at that boundary too: `ip ro 10.0.0.0 255.0.0.0
10.0.0.1` is still refused, because this console cannot enumerate the words after `ip`. An interface block's
keyword positions are the exception, because their sets are closed: the word after `ip`, `ipv6`, `switchport`,
`encapsulation`, `clock` and `no`, the value of `switchport mode` (`access|trunk`), and the eight words a DHCP pool
takes (`network`, `range`, `default-router`, `dns-server`, `lease`, `host`, `excluded-address`, `pool` after `no`)
together with the `infinite` value of `lease`. Everything else there is
a value and is left exactly as typed - `desc de uplink` sets the description "de uplink", and `sw ac vlan 20`
keeps its `20`. One divergence is stated rather than hidden: `sp` at `(config-if)#` is `speed` here, because
`spanning-tree` is not one of the words that prompt's dispatcher compares against (it hands the line to the
config handler, as it does `vlan 20`), where a box would call `sp` ambiguous. A one- or
two-letter prefix is also this simulator's answer rather than a claim about a particular switch: it is measured
against this console's shorter command set, so `sh s` reaches the spanning tree here where a box with `snmp`,
`ssh` and `spanning-tree` would call it ambiguous.

**Case is not part of a keyword.** A box matches the words of a command in any case - IOS says so in its own
words ("You can enter commands in uppercase, lowercase, or mixed case. Only passwords are case sensitive", and
"Cisco IOS commands are generally case-insensitive") - and this console did so for the first word of a line
only. `show ip ARP` reached the arp view, because that word is compared lowercased, while `show ip ROUTE` was
refused as an unknown view, and so were `show ip interface BRIEF`, `show ip DHCP binding`, `show ipv6 ND` and
`show mac ADDRESS-TABLE` - the views whose word is compared against a literal:

```
r1# show ip ROUTE
% Invalid show command: ip ROUTE
```

Every word after `show` is now compared through one lowercased copy of the line, so `show ip ROUTE` prints the
same table as `show ip route` and `SHOW IP ROUTE` does too. The rule covers the words of the command, not its
values: a MAC, a prefix and a description are passed through as typed, and a port name that reaches no port is
quoted back in the spelling it was given (a name that *does* reach a port is resolved the way a box resolves it,
and the block prints the panel's spelling). `research/show-keyword-case.md` has the sources and what a
box does with an interface name.

## A command with words it cannot use refuses them

Most of the commands above are the whole command. Some narrow to one object of their own: a port name
(`show interfaces <port>`, `show power inline <port>`, `show ip ospf interface <port>`, `show ip ospf neighbour
<port>`), a filter (`show mac address-table interface <port>`), an address or MAC (`show ip dhcp binding`) or a
zone name (`show ip dns zone`). On the rest, **a word they cannot use is refused, with the words quoted and the
command named**:

```
r1#show ip route 192.0.2.0/24
% show ip route does not take "192.0.2.0/24": the whole table is printed - run `show ip route` and read the row for the prefix
```

That refusal is the point, and it is worth stating why, because the alternative looked helpful. These commands used
to **ignore** the extra words and print the whole table. On a router whose table held one route, `10.0.0.0/24`,
asking whether `192.0.2.0/24` was installed printed:

```
Codes: C - connected, S - static, O - OSPF, B - BGP
C   10.0.0.0/24 is directly connected, GigabitEthernet0
```

A different prefix, printed as the answer to a question about this one. An operator checking whether a prefix is
installed is checking exactly the thing a silent drop fabricates: the table came back looking like a yes.

The same for `show arp <address>`, `show vlan <id>`, `show spanning-tree <port>`, `show lldp neighbors <port>`,
`show ip interface brief <port>`, `show running-config interface <port>`, `show access-lists <n>`,
`show etherchannel <word>`, `show vrrp <group>`, `show version <x>`, `show ip bgp <word>` and
`show ip bgp summary <word>`. Where a narrower question has an answer, the refusal names the command that gives it:

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

### A `|` is an output modifier, not a word of the name

The one place where the rest of the line is **not** the object being asked about is the pipe. A box's grammar is
`command | {begin | include | exclude} regular-expression`, where the pipe "follows" the show command and the
expression is "case sensitive" (Command Reference, IOS XE 17.12.x, Catalyst 9500, *Searching and Filtering Output
of show and more Commands*, and the same section in the 2960-X 15.2(7)E and Catalyst 1000 books). So
`show interfaces Fa0/1` followed by a pipe and `include packets` asks about port `Fa0/1` and filters that
port's block; the port name ends at the pipe.

This console read the whole rest of the line as a name, so the same command answered:

```
sw1#show interfaces Port 1 | include packets
% No interface Port 1 | include packets on Cambium cnMatrix EX2010-P-sw1
```

A socket that is in the answer a run without the pipe prints was reported missing, and the pipe — the one part of
the line the console had not understood — was never mentioned. The pipe is now answered before any view opens, so
every `show` door parses it the same way, and there are four answers:

```
sw1#show interfaces Port 1 | include packets
% `| include packets` is an output modifier, and this console has no output filter: a box would print only the lines of the answer that match the expression - `show interfaces Port 1` on its own prints every line

r1#show ip route | flurbish 10.
% `| flurbish 10.` is not an output modifier: after the pipe a box takes `begin`, `include` or `exclude` and an expression, and `show ip route` prints its whole answer here

r1#show ip route |
% Incomplete command: a pipe takes `begin`, `include` or `exclude` and then an expression, and this console models none of them - `show ip route` on its own prints the whole answer
```

A `|` with no command before it is refused the same way, asking for the view. The filter word itself is a keyword
and is matched in any case (`| INCLUDE` is a filter, not a bad word), as any *keyword* is; the expression after it
keeps its case, which is the rule the vendor states in the same paragraph. No filter is modelled: printing the
unfiltered block as though it had been filtered would be worse than refusing, because a reader would trust lines a
box had already discarded. `test/show-output-filter.test.js` pins the four answers, the missing-command case, and
that the port block itself is unchanged.

## `show running-config` is a config you can paste back

The output is a restorable backup, and that is a tested invariant rather than an aspiration
(`test/config-roundtrip.test.js`): paste it into a fresh device of the same model at the config prompt
and you get the same configuration, on the same ports.

Six properties make that work, all of them load-bearing:

* **Every interface block closes with `!`.** A bare `!` is the line every published running-config prints
  between two `interface` stanzas — the 4000 Series ISR default configuration goes
  `interface GigabitEthernet0/0/0` / `no ip address` / `negotiation auto` / `!` / `interface
  GigabitEthernet0/0/1` — and `exit` is not a line a box writes in this file at all: `exit` closes a
  session, not a stanza. Reading it back works because a new `interface` line inside interface mode is a
  mode switch and a global command at an interface prompt is applied in global config, so a paste still
  lands each address and `shutdown` on the port it belongs to
  (`test/running-config-stanza-separator.test.js`, `research/running-config-stanza-separator.md`).
* **Comment lines (`!`, `#`) are ignored in every mode**, including the `! PacketForge running-config`
  header the printer writes itself.
* **An interface stanza header spells the type out.** A box's file prints
  `interface FastEthernet0/6` / `interface GigabitEthernet1/0/1` / `interface Serial0/0/0`, never `Fa0/6`
  or `Gi1/0/1`, and prints the same header however the `interface` command was typed; a 2960-X's 28 stanzas
  therefore read `GigabitEthernet1/0/1` … `GigabitEthernet1/0/28`, and a subinterface keeps its tag after
  the expanded parent (`GigabitEthernet1/0/3.10`). The expansion is the one `show ip interface brief` uses,
  so the two vendor-shaped views cannot name one port two ways, and a name the table does not know
  (Ubiquiti's `Port 1`, `SFP+ 1`, RouterOS's `eth1`) is printed untouched
  (`research/running-config-interface-name.md`, `test/running-config-interface-name.test.js`).
* **An interface name is the rest of the line**, because some contain spaces — Ubiquiti's `Port 1`,
  `SFP+ 1`. Splitting on whitespace and taking one token made those devices' configs unreplayable.
* **A submode line is indented one space.** That is the vendor's own rule for the format of the file,
  stated as a numbered list in the prerequisites of four guides: top-level commands start with no
  indentation, "Indent commands within a first-level configuration submode one space", and a
  second-level submode two spaces - followed by "These indentation rules describe how the software
  creates configuration files for such commands as `show running-config` … Any configuration file
  generated on a Cisco device complies with these rules." So the body of an `interface` stanza, of
  `ip dhcp pool`, of `dns zone`, and the `bgp router-id` / `neighbor` lines under `router bgp` each
  begin with exactly one space. The printer used two - the depth of a *second*-level submode - which
  made every stanza line differ from the same box's file, and printed the `router bgp` children at the
  left margin, where a global command lives (`research/running-config-indent.md`,
  `test/running-config-indent.test.js`).
* **The file ends with `end`.** That is the line a real config closes with, and its job is the paste: read
  in global configuration mode it leaves configuration mode, so a pasted backup finishes instead of leaving
  the operator at `(config)#`. The number of bare `!` lines a box puts above it varies by release — one in
  the IOS 11.2 command reference, two in the ISR 4400 guide — so only `end` is copied. `end` typed at
  privileged EXEC, where a paste usually starts, is accepted and says nothing
  (`research/running-config-end.md`, `test/running-config-end.test.js`).

Configs copied out before this was fixed (block after block, with neither `!` nor `exit` between them)
still replay: the parser treats a new `interface` line inside interface mode as a mode switch, and falls
through to global config commands when a line is not an interface command. So does a config copied out of
a real box, where the separators are `!` lines.

### What the config contains

Being replayable is not enough — a config that omits the whole VLAN table is perfectly replayable. So
the output is also *complete*: every object the CLI can configure appears in it, in the form the parser
takes back.

| Section | Printed as |
|---|---|
| hostname | `hostname <name>` |
| interfaces | `interface <name>` block: description, `speed`, `duplex`, `clock rate <bps>` (a serial DCE), `encapsulation dot1q <vlan> [native]` (a subinterface), `ip address`, switchport VLAN/trunk, `channel-group`, `ip access-group`, `ip nat inside` / `ip nat outside`, `shutdown`, `vrrp <vrid> …`. A console or aux socket gets **no** block: a box writes its settings under `line con 0` / `line aux 0`, not as an interface |
| VLAN table | `vlan <id>`, or `vlan <id> <text>` with the name on the same line, and the name only when it is not the one a switch makes up for itself (`VLANxxxx`, zero-padded, and `default` for VLAN 1) - a file omits every value the box would have chosen, which is the rule stated below with the bridge priority as its one exception. VLAN 1 therefore writes no line at all, and a name typed as `VLAN0030` is dropped exactly as a generated one is. No `name` keyword is printed: `name` is a VLAN sub-mode command this console does not have, so the one-line form is the only one its parser takes back (`research/running-config-vlan-default-name.md`) |
| DHCP pools | `ip dhcp pool <name>` block: network, range, default-router, dns-server, excluded-address, lease, `host <addr> <mac>` |
| DNS zones | `dns zone <apex>` followed by `dns add <name> <type> <value>` |
| ACLs | `access-list <id> <rule>` |
| routing | `ip route <dest> <mask> <gateway> [iface] [<distance>]` - or the vendor's fully specified order, `ip route <dest> <mask> <iface> <gateway> [<distance>]` - `ip default-gateway <addr>`, and `ip routing` when the box is not in its platform's default state |
| NAT | `ip nat pool <name> <start> <end> netmask <mask>`, and one `ip nat inside source …` line per rule, printed as the command that creates it (`static <local> <global> [<protocol> <port>]`, or `list <local> pool <name>` or `list <local> interface <if>`, with `overload` on a PAT rule) |
| spanning tree | `spanning-tree priority <n>` whenever a bridge priority has been set - a typed `32768`, the value the box already assumes, is printed too, because the config records that an operator set one |
| name servers | `ip name-server <addr>` - a command line takes up to six addresses, space separated, and the printer writes one line for each; the `no` form accepts an address but clears every resolver, not just that one (below) |
| SCION | `scion <isd-as>` |
| OSPF | `ospf router-id <ip>`, `ospf area <id>`, and per interface `ip ospf cost <n>`, `ip ospf area <id>`, `ip ospf priority <0-255>`, `ip ospf passive` |
| BGP | `router bgp <as>`, `bgp router-id <ip>`, `neighbor <ip> remote-as <as>` |
| IPv6 addresses | per interface `ipv6 address <prefix>/<len>`, `ipv6 address autoconfig` |
| IPv6 routing | `ipv6 route <prefix>/<len> <next-hop>`, `ipv6 gateway <addr>` |
| IPv6 router advertisements | `ipv6 nd ra disable`, `ipv6 nd suppress-ra`, `ipv6 nd ra managed`, `ipv6 nd ra other-config`, `ipv6 nd ra lifetime <s>`, `ipv6 nd prefix <prefix>/<len> valid <s> preferred <s>` |

Three things the printer writes were missing from this table until they were measured: NAT and the bridge
priority, both printed above the first `interface` block (`engine/cli.js` writes them before it walks the ports),
and `clock rate`, printed inside the block of the serial port it belongs to. `test/config-completeness.test.js`
names `nat` and `stpPriority` among the keys the printer must cover, so the table now lists what that guard
already required.

Two fields are deliberately **not** printed because no command can express them: a DNS zone's
`defaultTtl` (records inherit it) and a per-record `ttl`. A default value that the device already
assumes — VRRP `preempt` on, `advertise 1`, switchport `allowed vlan all` — is printed only when it
differs, which is the same rule the rest of the config follows — with the bridge priority as the stated
exception, because "nobody set one" and "somebody set 32768" are different facts about a box.

`test/config-roundtrip.test.js` asserts both halves: the printed config replays into an identical
config, and no configured value is missing from the text.

That sweep cannot catch a feature *nobody configured in it*: it prints what each device holds and reads it
back, and a feature that is absent from the device is trivially consistent. Eight of them were absent from the
printer altogether - BGP, OSPF (global and per interface), SCION, name servers, IPv6 addresses, IPv6 routes
and gateway, and the IPv6 router-advertisement policy - so a backup of a configured router came back without
its routing protocol. `test/config-completeness.test.js` closes that hole from the other side: it declares
**every** key `device.config` can hold, with the pattern the printer must produce for it, so a new piece of
state that nobody taught the printer to print fails the suite instead of shipping as a silent omission.

### Undoing a command: every printed line should have a `no` form

A backup is only a backup if you can edit it back. The rule `test/config-undo.test.js` holds the features
below to is: add a command, then remove it, and the printed config returns **byte for byte** to what it was —
and removing something that is not there refuses and names the thing.

```
r1(config)#no hostname
% No hostname set (the device is named ASR 1001-X aggregation services router-r1)

r1(config)#no vlan 20
% VLAN 20 is still referenced by 1 port(s): Fa0/3 (trunk allowed, stored) - clear that first

r1(config-if)#no ip access-group 103 in
% Access list 102 is applied in on Gi0, not 103
```

**One printed line's `no` form is wider than the line.** `no ip name-server <address>` is accepted, and it
clears *every* resolver rather than the one named: the branch behind it never reads the address, so a name
that was never configured — or is not an address at all — clears the list just the same, and the only line
printed is `Name servers cleared`:

```
r1(config)#ip name-server 1.1.1.1
Name server 1.1.1.1
r1(config)#ip name-server 8.8.8.8
Name server 8.8.8.8
r1(config)#no ip name-server 8.8.8.8
Name servers cleared
```

`show running-config` then prints no `ip name-server` line at all, where "add it, remove it" promises the
`1.1.1.1` line back. The console's own `?` sentence for the form says `no ip name-server <address>` "removes a
name server"; that sentence is the code's claim and is the thing that is wrong. A per-address removal is the
fix, and until it lands this page records what the console does rather than what its index says.

Four commands used to be one-way doors — accepted, printed, and impossible to take back from the console —
and `no vlan` printed "VLAN 42 removed" whether or not a VLAN 42 existed:

| command | `no` form | removing what is not there |
|---|---|---|
| `hostname <name>` | `no hostname` | `% No hostname set (the device is named …)` |
| `ip dhcp pool <name>` | `no ip dhcp pool <name>` | `% No DHCP pool named <name>` |
| `dns zone <name>` | `no dns zone <name>` | `% No DNS zone named <name>` |
| `ip access-group <n> in\|out` | `no ip access-group <n> [in\|out]` | `% No access list <n> applied in on <port>` |
| `vlan <id>` | `no vlan <id>` | `% VLAN <id> does not exist` |

**The direction on its own is not a direction.** `help` prints this form as
`no ip access-group [<acl>] [in|out]`, so the number reads as optional - and the parser reads the word
standing in the number's place as the number: `parseInt('in', 10)` is `NaN`, every comparison against it
is true, and nothing is unbound. With 102 applied inside, `no ip access-group in` answers
`% Access list 102 is applied in on Gi0/0/1, not NaN`; with nothing applied, `% No access list NaN applied
in or out on Gi0/0/1`. The direction word is never reached - it is consumed as the number - so
`no ip access-group out` answers about `in` in the same words. The two lines that do what the index
promises are `no ip access-group 102 in`, which takes that one off (`Interface Gi0/0/1: access list
unapplied in`), and the bare `no ip access-group`, which clears both directions and names the ones it
actually cleared: in the session above - 102 inside, nothing outside - it answers `Interface Gi0/0/1:
access list unapplied in`, and `access list unapplied in and out` only when both directions were bound.
Reading a direction word as the number is the code's to fix
(`_accessGroup()`, `const want = rest[0] != null ? parseInt(rest[0], 10) : null` at `engine/cli.js:4471` - the
guard asks whether a word arrived, not whether it is a number, so `in` still parses to `NaN`); until it is,
this page does not advertise the direction on its own.

**Three printed lines do not have one yet.** `show running-config` writes `bgp router-id <ip>` in the BGP
block, `dns add <name> <type> <value>` under its zone, and `ipv6 nd ra lifetime <s>` at the top level. The
first two are removed only by `no router bgp <as>` and `no dns zone <apex>`, which take the whole object with
them - `no bgp router-id` and `no dns add www A 10.0.0.9` both answer `% Unrecognized config command`. The
lifetime line has no spelling that removes it, and one that looks like it does the opposite:

```
R1(config)#ipv6 nd ra lifetime 900
IPv6 RA router lifetime 900s
R1(config)#no ipv6 nd ra lifetime
% Incomplete command: ipv6 nd ra lifetime <seconds>
R1(config)#no ipv6 nd ra lifetime 900
IPv6 RA router lifetime 900s
R1(config)#no ipv6
IPv6 routes cleared
```

The bare `no` spelling asks for a value; the one with the value on it is **accepted** and answers with the
sentence the set form prints, because `_ipv6Nd()` shifts a leading `no` into a `negated` flag and never reads
it on the `lifetime` branch - so the value is written again rather than removed, on a box that never had one.
`no ipv6` clears the gateway and the static routes and leaves the line exactly as it was. The only way back is
to type the default, `ipv6 nd ra lifetime 1800`, which the printer omits because it is
`ra.DEFAULTS.routerLifetime`. The `no` forms the first two lines lack are the code's to add; this page records
what the console does.

Two of those refusals are there for more than tidiness:

* `no ip access-group 103 in` while **102** is applied refuses and names 102. Silently clearing "whatever is
  bound" would remove a policy the operator did not ask about.
* `no vlan 20` is **not** refused while a **trunk** carries it. Deleting a VLAN is a database operation and
  never rewrites an interface line - two operators answer the configuration half on Cisco Community ("No, you
  need to remove it manually from the trunk interface"; "only deleting it (\"no vlan 30\") won't make it
  disappear from the interface's config") - so the trunk keeps `switchport trunk allowed vlan ...` exactly as
  typed and simply stops carrying 20, because membership is derived: a trunk port is a member of a VLAN only
  while that VLAN exists. The receipt names the ports
  (`Fa0/4 stops carrying VLAN 20: the switchport configuration is unchanged (vlan 20 brings it back)`), a
  native VLAN is marked `(native)`, and the data path drops frames in a VLAN the database does not hold even
  when a trunk's list still names it (`research/trunk-allowed-vlan-on-vlan-delete.md`).
* `no vlan 20` still refuses while a port only **references** the VLAN: a native VLAN or an allowed list stored
  on a port that is not in trunk mode yet, or the **voice VLAN**, which an access port carries tagged and a
  trunk only stores (the name says which: `(voice)` against `(voice, no effect)`). The refusal names every
  field it found
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
config, and the name stays `default` instead of becoming `VLAN0001`. `no vlan 1` is refused in the vendor's own
sentence — `%Default VLAN 1 may not be deleted.`, with no space after the `%` — rather than answered with
`% VLAN 1 does not exist`, which was a denial of the one VLAN that is certainly there. The sentence is printed
verbatim, with nothing added: it is the string an operator sees on a real switch, and a script that matches the
refusal has to find it here too (the transcripts are in `research/default-vlan-refusal-wording.md`; the reason
the rule exists is this paragraph, not a console line no switch prints).

Neither can the name be changed. Every vendor documents the rule - the Catalyst 2960 configuration guide says
VLAN IDs 1 and 1002 to 1005 "are automatically created and cannot be removed", the Catalyst 9000 VLAN guide
says "You cannot delete or rename VLAN 1", and the Nexus 3548 layer 2 guide says "VLAN1 is the default VLAN
and cannot be created or deleted" - and `vlan 1 name Corp` is refused in the sentence IOS prints for it:

```
%Default VLAN 1 may not have its name changed.
```

A 2960-class lab capture gives the line under `name TEST` in the VLAN sub-mode, a CCNA exam question quotes the
error verbatim, and a Cisco Community thread has it as its subject line; `research/default-vlan-rename-wording.md`
collects the attestations and records the one character they disagree on - the leading `%`, which both sibling
sentences of the same message family carry. The console used to answer with a sentence of its own making,
`% VLAN 1 is the default VLAN: it cannot be renamed (its name is "default")`, which described the box rather
than refusing the command and added a reason no switch prints.

**A VLAN name is 1 to 32 characters, and that 32 is the width of the `show vlan` Name column.** The two are
one fact: the table has a 32-character cell, so a longer name can only be printed by shoving `Status` and the
ports list out of their columns — which is exactly what this console did, storing `vlan 4094 name <40
characters>` and printing one row eight columns wider than every other. Every vendor reference that documents
the field gives the same range — "valid values are an ASCII string from 1 to 32 characters" (Cisco IOS LAN
Switching Command Reference, `show vlan`), "names the VLAN with an ASCII string from 1 to 32 characters"
(Catalyst 2960-X 15.2(6)E command reference, `vlan`) — and a longer name is now refused, before the VLAN is
created, so a rejected name leaves nothing behind. What a real box prints for the breach is not witnessed on
IOS (the one transcript in hand is NX-OS, and it refuses: `Vlan name greater than 32 is not allowed!`), so the
sentence is this console's own while the limit it quotes is the vendor's; `research/vlan-name-length.md` gives
the sources and what would settle the wording.

**The other four default VLANs are refused by the same rule.** `no vlan 1002` answered `% VLAN 1002 does not
exist` — about a row `show vlan` prints before anybody configures anything, in the same session — while the
vendor's range table files them as normal VLANs that simply cannot be removed: "1002-1005 | Normal | Cisco
defaults for FDDI and Token Ring. You cannot delete VLANs 1002-1005." (Catalyst 6500 15.4SY guide, Table 26-1;
Catalyst 3560 12.2(25)SEA guide, Table 17-1), and the VLAN chapters add "You cannot delete the default VLANs
for the different media types: Ethernet VLAN 1 and FDDI or Token Ring VLANs 1002 to 1005". Each is now refused
in the same vendor sentence with its own number — `no vlan 1002` answers `%Default VLAN 1002 may not be
deleted.` — and the table is unchanged afterwards (`research/vlan-media-defaults.md`). A real box asked for a
range prints that line once per default VLAN it could not remove, which is what one command per id produces
here (`research/default-vlan-refusal-wording.md`).

The same table corrects a reason this console and its port validator both gave. `vlan 1002` and
`switchport access vlan 1002` said the id was "reserved by IEEE 802.1Q (1002-1005)", but the standard's
reserved VIDs are 0 and 4095 — the vendor's own table puts those two under **Reserved, for system use only**
and 1002-1005 under **Normal**. The refusal names the four media defaults and no longer attributes them to
the standard.

There is one list where the four are not refused at all: a trunk's *allowed* list always contains them, because
the device's default list is `1-4094` and the block cannot be removed from a trunk — see
[a trunk's allowed list](#a-trunks-allowed-list-is-edited-in-place-add-and-remove) below. Everywhere a *port* is
being put into a VLAN, the refusal stands.


## Config-mode commands

| Command | Effect |
|---------|--------|
| `hostname <name>` | set device hostname |
| `no hostname` | clear it, restoring the device's previous name |
| `interface <name>` | enter interface config mode |
| `interface <port>.<n>` | create a subinterface, or open an existing one, on that parent port - the prompt is `(config-subif)#`, as a box prints it (`research/subinterface-prompt.md`). `<n>` is the subinterface *number*, 1-4294967293, not a VLAN id (`research/subinterface-number.md`) |
| `no interface <port>.<n>` | remove a subinterface and its block; a physical port is refused, because a port is not something the console created |
| `ip route <dest> <mask> <gw> [iface] [<distance 1-255>]` | add static route, at that administrative distance (default 1). The vendor's fully specified order puts the interface first - `ip route <dest> <mask> <iface> <gw> [<distance>]` - and is accepted too (`research/ip-route-fully-specified.md`) |
| `no ip route <dest> <mask> [gw|iface] [gw] [<distance>]` | remove static route, in the words that made it (`no ip route <dest> <mask> <iface> <gw> <distance>` for a fully specified one) - with a distance, only that one |
| `ip default-gateway <gw>` | set default gateway (hosts) |
| `no vlan <id>` | remove a VLAN. A trunk that carries it does not refuse the line: the switchport configuration is left exactly as typed and the trunk simply stops carrying it, and the receipt names those ports (`ge1 stops carrying VLAN 22: the switchport configuration is unchanged (vlan 22 brings it back)`), marking a native VLAN `(native)`. It is refused while a port only **stores** a trunk parameter naming it (a port not in trunk mode yet) or holds it as its voice VLAN - `% VLAN 22 is still referenced by 1 port(s): ge1 (trunk allowed, stored) - clear that first` |
| `no ip dhcp pool <name>` | remove a DHCP pool |
| `no dns zone <name>` | remove a DNS zone and its records |
| `do show …` | run a `show` from config mode |
| `exit` / `end` | leave config mode |

**A subinterface can be taken back, and `help` names only the direction that makes one.** `no interface
<port>.<n>` deletes the logical interface and everything in its block; `no int` is the same line. The parent
port is untouched — it keeps its own address, and the `switchport mode trunk` that `encapsulation dot1q` set on
it — because the subinterface was the only object created, so removing it removes only that:

```
R1(config)#interface Gi0/0.20
Created subinterface Gi0/0.20 (parent Gi0/0)
R1(config-subif)#encapsulation dot1q 20
Subinterface Gi0/0.20 encapsulation dot1q 20
R1(config-subif)#exit
R1(config)#no interface Gi0/0.20
Subinterface Gi0/0.20 removed
R1(config)#no interface Gi0/0.20
% Interface not found: Gi0/0.20
R1(config)#no interface Gi0/0
% Gi0/0 is a physical interface and cannot be removed
```

The physical-port refusal is the rule rather than a message: a port is in the box's inventory, not in its
configuration, so the line that would delete one is refused and nothing is removed. An unknown name is the same
`% Interface not found: <name>` the `interface` line gives. The `help` index prints
`interface <parent>.<n>                 (creates a subinterface; n is 1-4294967293, not a VLAN id)` and no removal row beside it, so the console
accepts a line its own index does not mention; the `?`-key refusal for a `no` line does name it, in the words of
the branch it stopped:

```
R1(config)#no interface ?
% "?" is the help key, not a value: `no interface <name>` removes a subinterface - nothing was removed
```

That gap is the code's to close; this page records that the console takes the line.

**`interface range` is a command the box has, and the console says so.** IOS takes
`interface range {port-range | macro macro_name}`, enters `(config-if-range)#`, and applies every line typed
there to every port in the range - `Device(config)# interface range tengigabitethernet 1/1/1-2` then
`Device(config-if-range)# shut` (Cisco IOS XE 17 Interface Characteristics Configuration Guide, *Example:
Configuring a range of interfaces*; the Catalyst 2960 command reference, 12.2(44)SE, prints the same mode for
`interface range gigabitethernet0/1 - 2`). This console opens one port per line and has no range mode, so it
refuses the line by name:

```
s1(config)#interface range Fa0/1 - 3
% interface range "Fa0/1 - 3" is not modelled: a box takes `interface range <first> - <last>` (or `interface range macro <name>`) and applies each line to every port in it, and this console opens one port per line - no port was opened
s1(config)#
```

The words are the console's own, in the shape of the `vlan 10-12` list refusal: what a box does, what this
console does, and that nothing changed. It used to read the keyword as a port name and answer
`% Interface not found: range Fa0/1 - 3` - the sentence a misspelt socket gets, about a command the box really
has, which sends the reader looking for a socket called `range`. `no interface range ...` answers in the same
sentence and ends `nothing was removed`; a range typed with no keyword (`interface Fa0/1 - 3`) is still a port
name and keeps the missing-socket sentence. The refused line changes nothing - no port is opened, the cursor
stays where it was typed, and `show running-config` is unchanged. The sources are in
[research/interface-range-refusal.md](../research/interface-range-refusal.md).

## Interface-mode commands

A port answers to any spelling it is silkscreened or configured under, so `interface ether1` opens the
socket the panel calls `eth1` and `interface SFP+1` opens `sfp+1`. The naming table lives in
`engine/iface-name.js` and is used by both the console and the engine — there is no second copy, because two
copies of one naming rule drift. Ambiguity is refused rather than guessed: if two ports fold onto the same
spelling, that spelling resolves to nothing and the command says the port does not exist. What is printed
afterwards depends on the view, exactly as it does on a box: the panel spelling is the key and the name in
this console's own shapes (`show interfaces`, and the refusals), while a vendor-shaped view prints what the
vendor prints there - the type word spelled out in `show ip interface brief` and in a `show running-config`
stanza header, and the abbreviation in the tables that abbreviate (`show vlan`, `show etherchannel summary`,
the MAC table), and spelled out in the two that spell out (`show ip interface brief`, `show arp`). `research/interface-brief-name-spelling.md` and
`research/running-config-interface-name.md` carry the captures.

**A name that opens nothing leaves the session where it was.** `interface Fa9/9` on a box with no slot 9 is
refused, and the refusal is the whole effect: a box reports the line at the parser, before it runs, so the
mode does not move. Typed from inside another port's block, it keeps you on that port and the next line lands
there — which is what a pasted config expects, since pasted blocks are not separated by `exit`:

```
s1(config)#interface Fa0/1
s1(config-if)#interface Fa9/9
% Interface not found: Fa9/9
s1(config-if)#description uplink to core
Description set: uplink to core
```

That holds at `(config-subif)#` too, and for an incomplete `interface` line. The rule and the captures are in
[research/interface-refusal-mode.md](../research/interface-refusal-mode.md). A name the box *can* open still
moves the session, in every spelling — that is the same door.

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
other than what the device does. It is refused in the sentence a box prints for it: the mask has no prefix
length to name, so the box writes it as a hex word, echoes the address that was typed, and explains nothing —
and the line carries no `%` marker, like the `Bad mask /N` refusal beside it.

```
R1(config-if)#ip address 10.9.9.9 255.0.255.0
Bad mask 0XFF00FF00 for address 10.9.9.9
```

A mask that is not a dotted quad at all (`garbage`, a prefix length out of range) is a different thing and keeps
this console's own sentence, `% Invalid mask: <what was typed> - a netmask is a run of ones then zeros
(255.255.255.0, or 24)`, because nothing in hand says what a box prints for a mask word that does not exist.
[research/ip-address-bad-mask-hex.md](../research/ip-address-bad-mask-hex.md) has the transcript, the hex
spelling, and the one detail (zero-padding) that a second capture would settle.

The mask may be written as a prefix length (`24`) and is **stored in the dotted form** either way, so
nothing downstream has to guess which spelling it is looking at. The front panel applies the same rule: a
mask it cannot express as a prefix length is shown as `?`, never as a plausible number.

One subnet, one wire. A second **primary** address that lands in a subnet another port on the same box
already holds is refused, in the vendor's one line, and nothing is applied:

```
R1(config-if)#ip address 192.168.254.32 255.255.255.192
% 192.168.254.0 overlaps with GigabitEthernet0/0
```

The number is the network of the address *being typed*, under the mask being typed, and the line names the
port that got there first — in its full type spelling, whatever was typed to reach it (`int g0/1` is answered
about `GigabitEthernet0/0`), the same expansion `show ip interface brief` and the `show arp` Interface column
use. Overlap is asked of the two address ranges rather than of "the same subnet",
because `10.1.1.1/16` and `10.1.2.1/24` are different subnets that still cover the same host — a box refuses
those too, in either order. A subinterface collides exactly like a port (`Gi0/0/0.20` against `Gi0/0/0`), the
same port may be re-addressed freely, `no ip address` frees the subnet, and the same subnet on another device
is the normal case and is untouched.

The rule belongs to the routing table, so it is asked at **both** ends of a port's life. A port that is
administratively down installs no connected route, and takes an overlapping address without a word; opening
it is where the collision surfaces, in the same one line, and the port stays down:

```
R1(config-if)#shutdown
R1(config-if)#ip address 172.20.101.1 255.255.255.0
R1(config-if)#no shutdown
% 172.20.101.0 overlaps with GigabitEthernet0/0
```

Closing the incumbent first is what the box expects the operator to do, and the same `no shutdown` then
succeeds. What this still does not decide — an incumbent that is open but has no carrier, and an address a
DHCP client holds at run time — is recorded in
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
255.255.255.254` — so `192.168.1.0/31` and `192.168.1.1/31` are both accepted, one per end.

A **/32** is refused in the same sentence, because the mask leaves no host space at all: Cisco's guide says
`255.255.255.255` "describes a subnet with only one IPv4 host address" and is "strictly reserved for use on
links that can have only one address ... the loopback interface", and three transcripts (a GRE tunnel, a 2811
serial port, a 4331 routed port) show a box answering `Bad mask /32 for address <what was typed>` on a port.
The loopback exception is stated against the interface's type, and no catalogue device carries a loopback
interface, so every port here refuses with this sentence — except inside the two blocks below, which are
answered first. A `/0` is left exactly as it was: nothing in hand says which sentence a box prints for
`ip address 0.0.0.0 0.0.0.0`. What is known, what is inferred and what remains open is in
[research/ip-address-not-a-host.md](../research/ip-address-not-a-host.md).

**Some addresses are not host addresses under any mask.** An address in `0.0.0.0/8` — the "this network" block —
or `127.0.0.0/8`, the loopback block, is refused before the mask is judged, in a second sentence that names the
address and prints no prefix:

```
R1(config-if)#ip address 0.0.0.1 255.255.255.0
Not a valid host address - 0.0.0.1
R1(config-if)#ip address 127.0.0.2 255.0.0.0
Not a valid host address - 127.0.0.2
```

Three pastes settle it: the sentence carries no `%`, like its `Bad mask` sibling; it echoes the address exactly as
typed; and it is the same for a /16 and a /24, which is why the block is tested before the mask. It reaches the
/32 rule above as well — `ip address 127.0.0.1 255.255.255.255` answers `Not a valid host address - 127.0.0.1`
and not `Bad mask /32 for address 127.0.0.1`, because a loopback interface refuses 127/8 too. `0.0.0.0` itself sits
outside the block on purpose: whether a box takes `ip address 0.0.0.0 0.0.0.0` is the `/0` question above, and it
is still accepted here. A mask that is not a run of ones is still refused ahead of the address, in the box's own
line (`Bad mask 0XFF00FF00 for address 0.0.0.1`), and two neighbours stay
outside this rule: `224/4` is **still accepted** (the one paste that reports a refusal is a reader comment printing
a different sentence, so it was not adopted), and `255.255.255.255` is refused by the /32 rule above
(`Bad mask /32 for address 255.255.255.255`), not by this one.
[research/ip-address-host-range.md](../research/ip-address-host-range.md) carries the sources, the ordering argument
and what would settle each of them.

| Command | Effect |
|---------|--------|
| `ip address <ip> <mask>` | assign an IP (e.g. `192.168.1.1 255.255.255.0`); the mask must be a run of ones then zeros and may be written as a prefix length (`24`), and the address must be a host address of that subnet (not its network or broadcast address, except on a `/31`, and never inside `0.0.0.0/8` or `127.0.0.0/8`, which are refused by name under any mask). No word may follow the mask: IOS's syntax is `ip address ip-address mask [secondary]`, and
`secondary` adds a second address rather than replacing the primary - which this model, one address per port,
cannot honour, so `secondary` is refused by name and every other word is refused with the word quoted |
| `no ip address [<ip> <mask>]` | remove the IP. The bare line removes what the port holds; the two-word form names the address, and removes it only when it is the one the port holds - a mismatch is answered `% Invalid address:` with the held address printed, and nothing is removed. The mask may be a prefix length (`24`). `secondary` is refused by name (one address per port), a single address with no mask is `% Incomplete command`, and any other word is refused with the word quoted and nothing removed ([research/no-ip-address-named-form.md](../research/no-ip-address-named-form.md)) |
| `clock rate <bps>` | (serial only) make this end the DCE and clock the line, e.g. `clock rate 64000`. Refused on a non-serial port. The rates are the vendor's menu plus the port's own; a value in the parser's 300-top range that is not on the menu is rounded and reported as `%Clockrate rounded to nearest value that your hardware can support.`, and one below 300 or above the port is refused with the range quoted (`research/serial-clock-menu.md`) |
| `no clock rate` | drop the clock, leaving this end as DTE |
| `ip address dhcp` | make the port a DHCP client; the address it ends up with is the outcome of the exchange, not part of the configuration |
| `encapsulation dot1q <vlan> [native]` | subinterface only: tag the subinterface's frames with `<vlan>`, and make the parent port a trunk. `native` makes this subinterface the parent's handler for untagged frames, so the parent's native VLAN becomes `<vlan>` and the frames it routes out leave untagged; one subinterface per parent may hold it. Refused on a physical port, for a VLAN outside 1-4094, for any other encapsulation, and for any other word after the id |
| `shutdown` / `no shutdown` | administratively disable / enable |
| `description <text>` | set a description |
| `exit` | back to config mode |

**The number names the subinterface; `encapsulation dot1q` names the VLAN.** On IOS the number after the dot
runs 1-4294967293 and the tag is a separate command taking 1-4094, and the two need not match
(`research/subinterface-number.md`). This console keeps the one-line router-on-a-stick habit: a number that
*could* be a VLAN id seeds one, so `interface Gi0/0.20` prints `encapsulation dot1q 20` even when the line was
never typed, and naming a different one (`encapsulation dot1q 30` inside `Gi0/0.20`) stores what was typed and
prints that. A number above 4094 is only a name - `interface Gi0/0.5000` opens, prints no encapsulation line,
and carries no tag until one is typed. The command is refused on a physical port
(`% encapsulation dot1q is only valid on a subinterface (e.g. Gi0/0.10)`) and for a VLAN outside 1-4094, anything
but `dot1q` is refused as an unsupported encapsulation, and the parent port is made a trunk - which is the
router-on-a-stick pairing a saved config has to carry.

A number outside 1-4294967293 is refused as a number
(`% Subinterface number out of range: 0`), which is the parser's answer and not a VLAN error.

The one optional word is `native`, and it is the only word the vendor's syntax puts there. It makes the
subinterface the port's default handler for untagged frames: the parent's native VLAN becomes the
subinterface's VLAN, frames the subinterface routes out leave untagged, and `show running-config` prints
`encapsulation dot1q <vlan> native` on the subinterface rather than a `switchport trunk native vlan` line on
the parent - the two places a router can express the one fact, and the vendor presents them as alternatives.
One subinterface per parent may be native (a trunk has one native VLAN); a second is refused, naming the first.
Typing the line again without the word, or removing the subinterface, gives the untagged handling back, and
with no explicit native VLAN that is VLAN 1. Any other word after the id - a second VLAN id included - is
refused with the word quoted and the encapsulation unchanged, which is the class of silent discard
`ip name-server` and `clock rate` were fixed for (`research/encapsulation-dot1q-native.md`).

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

**`no ip address` takes the address too.** The other half of that syntax block is
`no ip address ip-address mask [secondary]`, and it is the form a configuration file uses to take back one
address rather than whatever the port happens to hold. This console refused every word after `no ip address`,
so that line - and Cisco's own workaround for CSCvr84846, which types `no ip address 192.168.1.100 255.255.255.0`
on a live SVI - could not be replayed. The form is now accepted and the address is **matched**: the port must
hold that address under that mask (a prefix length is accepted, as `ip address` accepts one), or the answer is
`% Invalid address: Fa0/1 holds 10.0.0.1/24, not 10.0.0.9/24 - nothing was removed` and the configuration does
not move. The `% Invalid address` fragment is the vendor's - one operator's paste of the mismatch - but the
sentence after it is this console's, because no capture in hand shows the rest, and whether the mask must match
as well as the address is inferred rather than witnessed
([research/no-ip-address-named-form.md](../research/no-ip-address-named-form.md)). A DHCP client is refused by
name there (its address is leased, not configured) and the bare form still removes the client.

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
| `ipv6 nd ra enable` / `ipv6 nd ra disable` | advertising is **on by default** on any interface that carries an IPv6 address (`l3-forward` only); `disable` stops it, `enable` starts it again |
| `ipv6 nd ra managed` / `ipv6 nd ra other-config` | set the M / O flag (`no …` clears it) |
| `ipv6 nd ra lifetime <s>` | router lifetime; `0` means "not a default router" |
| `ipv6 nd prefix <prefix>/<len> [valid <s>] [preferred <s>]` | override the lifetimes of a prefix that is already advertised, or add one; the `/64` of an interface address is advertised without this line |
| `no ipv6 nd prefix <prefix>/<len>` | withdraw a prefix |
| `ipv6 nd suppress-ra` | stop periodic advertisements, still answer solicitations (`no …` resumes) - the vendor's own off switch, and the one a real config carries |
| `show ipv6 nd` | what this device would advertise, and which interfaces are waiting |

Interface mode:

| Command | Effect |
|---------|--------|
| `ipv6 address <addr>/<len>` | assign a static **global** address; a `fe80::/10` address is refused (see below) |
| `ipv6 address autoconfig` | take an address from a router advertisement (SLAAC) |
| `no ipv6 address` | remove the static address |
| `no ipv6 address autoconfig` | stop autoconfiguring and drop the learned address |

**A link-local is not this command's to take.** `ipv6 address <addr>/<len>` is the
global form, and `fe80::/10` is not a global prefix (RFC 4291 §2.5.6). IOS keeps a
link-local in a different form of the command - `ipv6 address <addr> link-local`,
which takes no prefix length - and refuses the mix-up in its own words:

```
R1(config-if)# ipv6 address fe80::1/64
% Link local requires link-local keyword
  This console derives the link-local from the port's MAC (Gi0/0 is fe80::ff:fe00:0); it has no manual form.
R1(config-if)# ipv6 address 2001:db8::1 link-local
% Invalid link-local address
```

The first line of each answer is the box's (`% Link local requires link-local
keyword` on IOS 15.x and 15.5(3)M5; `% Invalid link-local address` for a global
address given the keyword). The second line is this console's: it keeps **no**
per-interface link-local, because every interface derives one from its MAC and
`show interfaces` prints it beside the global address (`ipv6: 2001:db8:1::1/64,
link-local fe80::ff:fe00:0`). Nothing is stored for any of the three refusals, so
`show running-config`, `show interfaces` and `show ipv6 nd` cannot report - or
advertise - a link-local address that was never taken. The same address therefore
never reaches a router advertisement as a SLAAC prefix.

A router advertises a prefix **only on the link where it holds an address inside
that prefix**, because a prefix is a promise to route the traffic addressed in
it. `show ipv6 nd` prints that mapping and says so when a configured prefix is
attached to no interface.

A `/64` **address is an announcement by itself**. Cisco's `ipv6 nd prefix`
reference states the default in its Usage Guidelines - "By default, prefixes
configured as addresses on an interface using the ipv6 address command are
advertised in router advertisements" - and gives the parameters the box uses
when nothing was configured: valid lifetime 2,592,000 s (30 days), preferred
604,800 s (7 days), on-link (L) and autoconfiguration (A) set. So a router with
one line, `ipv6 address 2001:db8:aa::1/64`, already hands every host on that wire
a prefix to form an address from; the `ipv6 nd prefix` command exists to change
those lifetimes, not to switch the announcement on. Only a `/64` is derived,
because a host splices a 64-bit interface identifier onto the advertised prefix
(RFC 4862 §5.5.3) - a `/48` or `/128` changes no host's behaviour.

An explicit entry for a prefix **replaces the parameters of that prefix and
nothing else**; other interface prefixes keep going out. `show ipv6 nd` prints a
`source` column so the two cannot be confused: `interface address` for the
automatic entry, `configured` for one an operator wrote.

Advertising itself is **the default**, not a step: RFC 4861 §6.2.1 has a router
send unsolicited advertisements on every link it is configured to serve, and
Cisco's `ipv6 nd ra suppress` reference gives the same state as its Command
Default - "IPv6 router advertisements are automatically sent on Ethernet and FDDI
interfaces if IPv6 unicast routing is enabled". A box whose port carries no IPv6
address advertises nothing, and the two commands that stop it are `ipv6 nd ra
disable` and `ipv6 nd suppress-ra` - the latter being the spelling a Cisco config
prints. Whichever one was used is the line `show running-config` writes; a device
that never touched router advertisements writes none.

```
R1(config)# interface Gi0/0
R1(config-if)# ipv6 address 2001:db8:aa::1/64
IPv6 address 2001:db8:aa::1/64 on Gi0/0
R1(config-if)# end
R1# show ipv6 nd
IPv6 router advertisements on R1:
  Device      : generic-router  (l3-forward)
  Advertise   : enabled  (the default; `ipv6 nd suppress-ra` stops the periodic ones)
  Flags       : M=0 O=0   router lifetime 1800s
  Timers      : reachable 0ms, retrans 0ms, hop limit 64
  Prefixes    : 1   (1 from an interface address)
    prefix                    L  A  valid(s)    preferred(s)   source
    2001:db8:aa::/64          1  1  2592000     604800         interface address
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
Enter configuration commands, one per line.  End with CNTL/Z.
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
Codes: L - local, C - connected, S - static, R - RIP, M - mobile, B - BGP
       D - EIGRP, EX - EIGRP external, O - OSPF, IA - OSPF inter area
       N1 - OSPF NSSA external type 1, N2 - OSPF NSSA external type 2
       E1 - OSPF external type 1, E2 - OSPF external type 2
       i - IS-IS, su - IS-IS summary, L1 - IS-IS level-1, L2 - IS-IS level-2
       ia - IS-IS inter area, * - candidate default, U - per-user static route
       o - ODR, P - periodic downloaded static route, H - NHRP, l - LISP
       a - application route
       + - replicated route, % - next hop override, p - overrides from PfR
Gateway of last resort is not set
C   10.0.1.0/24 is directly connected, GigabitEthernet0/0
L   10.0.1.1/32 is directly connected, GigabitEthernet0/0
C   10.0.2.0/24 is directly connected, GigabitEthernet0/1
L   10.0.2.1/32 is directly connected, GigabitEthernet0/1
R1# ping 10.0.1.10
Type escape sequence to abort.
Sending 5, 100-byte ICMP Echos to 10.0.1.10, timeout is 2 seconds:
!!!!!
Success rate is 100 percent (5/5), round-trip min/avg/max = 0.002/0.002/0.002 ms
```

The success-rate line is the vendor's, clause and all. When at least one echo comes back it goes on with
`, round-trip min/avg/max = <min>/<avg>/<max> ms`; when none does it stops at the rate, because there is no round
trip to average. Both halves are the vendor's own: the 4/5 ping in Cisco's NAT connectivity note prints
`Success rate is 80 percent (4/5), round-trip min/avg/max = 1/1/2 ms`, and the ping/traceroute note prints
`Success rate is 0 percent (0/5)` with nothing after it. The figures keep a fraction where a real box would print
whole milliseconds - an IOS host's `0/0/0 ms` for a sub-millisecond path - because the fraction is what tells a 1 m
patch lead from a 40 km span, and the same `formatRttMs` spelling is used by a `traceroute` hop line beside it.
`test/ping-round-trip-clause.test.js` pins both halves of the rule.

A box prints **no per-echo line** after that: each echo is one character of the marks line, and the rate is the
last word on the run. This console used to append `Reply from <address>: bytes=100 time=<rtt> ms` for every
answered echo and `Request timed out (seq N)` for every lost one, which is **Windows** `ping`'s output shape - `C:\>`
prompts in Cisco's own troubleshooting deck print exactly that, with `TTL=`, beside IOS captures of `!!!!!` and the
rate. The per-echo sentences are gone; `research/ping-report-shape.md` holds the captures that settled it and
`test/ping-report-shape.test.js` pins the four-line report.

Only the two connected subnets are in the table because no default has been configured yet, and the console
says so between the legend and the first row (`Gateway of last resort is not set`); `ip route 0.0.0.0 0.0.0.0`
adds the default this table can hold, while `ip default-gateway` is the host's way to one and is inert on a box
that routes (`research/ip-default-gateway-when-routing.md`), and their rows — plus the `(down: no cable)` a port
with nothing plugged into it prints beside its subnet — are in
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
`GigabitEthernet0/0  unassigned  YES unset  down  down`. `manual` belongs beside an address configured at the console, and
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

**A subinterface has a row, directly under the port it rides on.** The table walks the interface list in
the device's own order and prints a child immediately after its parent, before the next socket — the order a
box prints, and the order `show interfaces` prints. On a router-on-a-stick whose `Gi0/0/0` is cabled:

```
r1#show ip interface brief
Interface              IP-Address      OK? Method Status                Protocol
GigabitEthernet0/0/0   unassigned      YES unset  up                    up
Gi0/0/0.10             10.10.0.1       YES manual up                    up
Gi0/0/0.20             10.20.0.1       YES manual up                    up
GigabitEthernet0/0/1   unassigned      YES unset  down                  down
GigabitEthernet0/0/2   unassigned      YES unset  down                  down
```

Both views iterate one walk (`orderWithChildren` in `engine/cli.js`), so they cannot order one list two ways.
This table used to append every subinterface after every physical port, one screen away from the port it
rides on, which no box prints (`research/interface-brief-subinterface-order.md`,
`test/interface-brief-subinterface-order.test.js`). A child that cannot be placed — an orphan whose parent is
not in the list — is still printed, at the end: a row that cannot be ordered is not a row to hide.

**An EtherChannel is an interface, and it has a row.** A bundle's members are listed as their own ports, and
the bundle itself is listed too — after them, in bundle-number order — as `Port-channel1` with
`unassigned  YES unset`, and `up up` only when at least one member is really in the bundle:

```
Port-channel1          unassigned      YES unset  up                    up
Port-channel20         unassigned      YES unset  down                  down
```

The name is spelled out **here** and shortened to `Po1` in `show etherchannel summary` and the MAC table's
`Ports` column, which is what a box does: a table cell abbreviates the type word, a row whose subject *is* the
interface does not (`Port-channel4 ... up up` beside `4 Po4(SU) LACP Gi4/31(P)` in one capture; both names come
from `engine/lag.ts`, so they cannot disagree about which bundle they mean). The state is the bundle's own: a
bundle no member joined is `down down` even while each member is `up up`, carrying traffic as a single link —
`show etherchannel summary` shows that as `Po1(SD)` with the members `(I)`, and both views read the same
predicate. `research/port-channel-in-interface-brief.md` carries the captures and what is still open.

The header is padded from the same widths as the rows, so a heading cannot sit one column to the right of the
values beneath it — `Method` above `manual`, `Status` above `down`.

**The Interface cell spells the type out where it fits, and abbreviates it where it does not.** A box's own
table prints `GigabitEthernet1/0/1` (20 characters) and `FastEthernet0/1`, never `Gi1/0/1`; it prints
`Te1/1/1`, `Tw1/0/1` and `Fo1/1/1` where the full names would be 23, 23 and 25 — the 23-column Interface
field is the boundary, not a list of types. One capture proves it on a single box: a Catalyst 9300-48UXM's
`show ip interface brief` (Cisco's Zero-Touch Provisioning guide, 17.1 through 17.18) prints `Tw1/0/1`,
`Te1/1/1` and `Fo1/1/1` short beside `GigabitEthernet1/0/1` and `TwentyFiveGigE1/1/1` long. A live 9200
prints `Te1/1/1` in this table while its `show running-config` and `show ip route` say
`TenGigabitEthernet1/1/1`, and a subinterface follows the same rule (`GigabitEthernet0/0/1` beside
`Gi0/0/1.10`, whose full name is 23). The catalogue keeps the panel's short spelling, so `interface Te1/1/1`,
`interface TenGigabitEthernet1/1/1` and a name pasted out of this table all reach the same port; only the
printed cell changes, and only in this view — `show interfaces` still heads each block with the panel
spelling (`Gi1/0/1`), because that block is this console's own shape rather than a vendor table. Tables that
abbreviate on a real box still abbreviate here — `show vlan`'s Ports list, `show etherchannel summary`'s
members and the MAC table's `Ports` column print `Fa0/1`/`Gi1/0/1` exactly as a box does — and the other
vendor-shaped view, the `show running-config` stanza header, spells the type out (`interface
TenGigabitEthernet1/1/1`) for the same reason (`research/running-config-interface-name.md`). The captures,
the arithmetic behind the boundary, and what is still open (the exact 22/23 edge, and a vendor whose word
this table does not know) are in
[research/interface-brief-type-abbreviation.md](../research/interface-brief-type-abbreviation.md).

A device that is **not part of a topology** has no cables to report on, so its ports keep their old
answer (`up` unless shut). The command cannot know about a cable it was never told about, and inventing
`down` for every port of a bare device would be a different wrong answer.

#### A console port is a line, not an interface

A router's console and aux sockets are in the catalogue, because the faceplate draws them and the physical
layer needs to know they are out-of-band — `canMate()` refuses to mate one with a data port and negotiates a
*baud rate* between two of them. They are **not** interfaces, and no view that lists interfaces prints one:

```
Catalyst 2811# show ip interface brief
Interface              IP-Address      OK? Method Status                Protocol
FastEthernet0/0        unassigned      YES unset  down                  down
FastEthernet0/1        unassigned      YES unset  down                  down
Serial0/0/0            unassigned      YES unset  down                  down
Serial0/0/1            unassigned      YES unset  down                  down
```

The 2811 declares `Console` and `Aux0` as well, and none of the three views prints them: not this table, not
a `Console (console, 1G), MAC …` block in `show interfaces` (with a MAC address and a gigabit line rate
invented for an RS-232 socket), and not an `interface Console` stanza in `show running-config`. On a box the
console is a **line** — `show running-config` writes `line con 0` / `line aux 0`, the box's own line view (which
this console does not have) reports it as `0 CTY` beside the aux port's `129 AUX 9600/9600`, and it runs at
9600 baud, 8 data bits, 1 stop bit, no parity. A
box's `show ip interface brief` on a router that has a console lists its Ethernet, serial, loopback,
subinterface and bundle ports and nothing else. Asking this console for the socket by name answers in one sentence:

```
Catalyst 2811# show interfaces Console
% Console is the console line, not an interface: it carries a terminal at a baud rate, not frames, and a box keeps its settings under `line con 0`
```

`interface Console` is refused with the same words and leaves the cursor where it was, because opening it let
`ip address` succeed on a socket that can never carry an address and then hid the address from every table.
The socket stays in the port list, on the panel and in the topology — a lab may cable a console cable to it;
it is simply not an interface. `line con 0` itself is not a mode here, so nothing else is claimed about it.
The captures and what is still open are in
[research/console-is-a-line-not-an-interface.md](../research/console-is-a-line-not-an-interface.md).

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

A bundle has two names, and neither is a port this view prints. `Po1` - the spelling in
`show etherchannel summary` and in the MAC table - and `Port-channel1` - the spelling of the
`show ip interface brief` row - are recognised when a group with that id is configured, and answered as what
they are, with the view that does print the bundle and its members:

```
s1#show interfaces Po1
% Port-channel1 is an EtherChannel bundle: this console has no block for one. `show etherchannel summary` lists the bundle and the ports that carry it.
```

A group nobody configured is refused as the name nobody has, like any other; and no block is invented for a
bundle, because a box's own block carries a hardware address, a status and counters that this model keeps on the
members, not on the bundle (`research/port-channel-show-interfaces.md`).

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
VLAN indistinguishable from a native VLAN of 1. `test/switchport-agreement.test.js` compares the two across 2,160
port states - the matrix's size is a reading, not a memory: the guard prints it on every run - and checks every
claim the sentence makes against `classifyEgress`.

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

Neither command takes a word after its value. The syntax lines are
`speed {10 | 100 | 1000 | 2500 | 5000 | auto [10 | 100 | 1000 | 2500 | 5000] | nonegotiate}` and
`duplex {auto | full | half}`, so `speed 100 flurbish` is a parse error on a box, and this console now refuses
it by name rather than forcing the rate and dropping the word. Two words are real and unimplemented, and are
refused as such: `speed auto 10` (autonegotiate only at the rates named) and `speed nonegotiate` (stop
negotiating, pin 1000 Mb/s) - neither is modelled, and answering the first as a plain `speed auto` reported a
different setting than the one typed. The `no` forms differ from each other: `no speed` takes no argument,
while `no duplex {auto | full | half}` takes the same three words as its positive form and returns the port to
the default, `auto`. `research/speed-duplex-grammar.md` carries the syntax lines and the rest of the
measurement.

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
* **an access EtherChannel is one port, named by the bundle.** A working two-member bundle in VLAN 10 prints
  `Po1`, and its members appear in no cell — not in VLAN 10 and not in VLAN 1 — because the switch forwards on
  the logical interface. An IOU switch with the members bundled prints `10 VLAN0010 active Po1` over an empty
  VLAN 1 row (`test/vlan-brief-etherchannel.test.js`; `research/show-vlan-brief-etherchannel.md`). A member
  that never negotiated LACP still carries traffic as an ordinary single link, so it keeps its own name (the
  rule the MAC table applies to that state), and the bundle names are printed after the physical ports, the
  order the vendor's EtherSwitch sample shows (`... Gi4/0, Gi4/1, Po1`).

A VLAN has a row if it is in the VLAN database — configured with `vlan <id> [name] [<text>]`, created by
`switchport access vlan <id>`, or held from boot (VLAN 1 is there from power-on, named `default`, before anybody
types anything) — and no row otherwise. A trunk's allowed list creates nothing, and after `no vlan 22` the row
goes even though the port that names 22 still points at it: `show interfaces` reports that port inactive and
`vlan 22` is what brings it back. A configured VLAN nothing carries prints an empty Ports column rather than an
invented port.

**A switch has five VLANs before anything is configured**: 1, and the four reserved Token Ring / FDDI defaults,
1002-1005. They belong to the VLAN database from power-on and print `act/unsup` with an empty Ports column.
No port joins one here — `switchport access vlan 1002` answers `% access VLAN 1002 is reserved: it is one of
the four FDDI and Token Ring defaults (1002-1005)`, the word before the id naming the door that refused it
(`voice VLAN` at `switchport voice vlan`, `VLAN id` for `vlan 1002` itself) — because nothing in this model
carries FDDI or Token Ring; that refusal is this model's decision, not a witnessed console line, since the
vendor documents the ids as non-Ethernet media defaults but no capture shows what the command answers
(`research/media-default-vlan-as-access-vlan.md`). They are not configuration: `show running-config` never
prints them, and they keep their place in the sort, so a hand-made VLAN 2000 appears after 1005. The names are
`RESERVED_VLANS` in `engine/vlan.js`, the same list the reserved-range refusal quotes. A device that is not a
bridge is not given the reserved rows, because it has no VLAN database
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
  10.1.1.9` answered `Route added: 192.0.2.0/8`, installing a prefix nobody asked for. It now applies the same
  contiguity rule as `ip address` and refuses the mask: `% Invalid mask: 255.0.255.0 - a netmask is a run of ones
  then zeros (255.255.255.0, or 24)`. The sentence differs from the port door's `Bad mask 0X...` on purpose —
  the only transcript in hand is an `ip address` line typed at an interface prompt, and a static route's
  refusal for the same mask is not witnessed by anything.
* **A route with nowhere to go is not installed.** `ip route <dest> <mask>` with neither a next hop nor an
  interface used to be accepted as `on-link`, and the table then described it as *"no next hop: ARP for the
  destination on that segment"* - naming a segment the command never mentioned. It is now
  `% Incomplete command: ip route 192.0.2.0 255.255.255.0 needs a next hop or an interface`. The interface-only
  form is still legal and still says what it will take to work.
* **A number after the next hop is a distance, not a port.** The vendor's syntax ends
  `{ ip-address | interface-type interface-number [ip-address] } [dhcp] [global] [distance] [multicast]
  [name next-hop-name] [permanent | track number] [tag tag]`, with `distance` an administrative distance from
  1 to 255 whose default for a static route is 1 (Cisco IOS IP Routing: Protocol-Independent Command Reference,
  `ip route`). This console read that slot as an interface and refused the backup route every IOS course
  teaches:
  ```
  r1(config)#ip route 0.0.0.0 0.0.0.0 10.1.1.2 200
  % 0.0.0.0/0: no interface called "200"
  ```
  It now stores the number on the route, prints it in the bracket (`S*  0.0.0.0/0 [200/0] via 10.1.1.2`),
  writes it back into `running-config` so the line replays, and lets it decide which route is installed - so a
  floating static sits marked `(not installed: the S route for this prefix has distance 1)` while the primary
  lives, and carries the traffic when it goes. A distance outside 1-255 is refused by name, and 255 keeps the
  vendor's meaning - *"routes with a distance value of 255 are not installed in the routing table"* - so the row
  is printed and marked, and no packet is ever sent by it. What is still not read from that syntax: `name`, `tag`,
  `permanent`, `track` and `vrf` (`research/static-route-distance.md`).

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
% VLAN id 1002 is reserved: it is one of the four FDDI and Token Ring defaults (1002-1005)
sw1(config-if)#switchport access vlan WORD
% Invalid VLAN id "WORD": an access VLAN is a whole number from 1 to 4094
sw1(config-if)#switchport voice vlan banana
% Invalid VLAN id "banana": a voice VLAN is a whole number from 1 to 4094 or "none"
```

Three of those five doors take a **single** id, and that is the whole grammar: an access, native or voice VLAN
is one VLAN. The two global commands are the exception, because on a box their argument is a **list** - Cisco's `vlan`
reference says it in one sentence: *"You can enter a single VLAN ID, a series of VLAN IDs separated by commas, or
a range of VLAN IDs separated by hyphens"* (Catalyst 9600, IOS XE 17.7, VLAN Commands), and the configuration
guides write the syntax as `vlan vlan_ID {[-vlan_ID]|[,vlan_ID]}`. This console creates one VLAN per command, so
the form is still refused — but it used to be refused as an invalid id, which is a claim about IOS that is false:

```
sw1(config)#vlan 10-12
% VLAN list "10-12" is not modelled: a box takes a range (10-12) or a comma-separated list (10,12) on `vlan`, and this console takes one id per line - nothing was changed
sw1(config)#no vlan 20,22
% VLAN list "20,22" is not modelled: a box takes a range (10-12) or a comma-separated list (10,12) on `vlan`, and this console takes one id per line - nothing was removed
```

The refusal is the one line above, it names both of the vendor's spellings and the form this console takes
instead, and it changes nothing — `show vlan` and `show running-config` are exactly as they were, and the ids the
advice asks for (`vlan 10`, `vlan 11`, `vlan 12`) do work. What is *absent* is creating or removing several VLANs
from one command, and the note says so instead of pretending the grammar does not exist
(`research/vlan-list-argument.md`; the suite is `test/vlan-list-argument.test.js`). A token that is not a list —
`WORD`, `1.5`, `-5`, `4095`, a dangling `10-` — keeps the per-id refusals above. The sentence for an id outside
1-4094 is this console's own: a box refuses it in the parser's words, and the range the parser advertises belongs to
the running image — `<1-4094>` on a LAN Base 2960, `<1-1005>` on a LAN Lite one (research/vlan-id-range-per-door-and-per-image.md).

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

### Pinging this box

An address the device itself holds is answered by its own IP stack: the echo is never built into a frame, so nothing
ARPs for the box's own address and the round trip is the empty path's. The rule is the IP layer's, not the console's -
RFC 1812 §5.2.3 delivers a packet locally when its destination "exactly matches one of the router's IP addresses", and
§4.3.3.6 requires the echo server to answer what is sent to the router; RFC 1122 §3.2.2.6 puts the same duty on a host
(research/ping-own-address.md).

```
r1> ping 10.0.0.1
Type escape sequence to abort.
Sending 5, 100-byte ICMP Echos to 10.0.0.1, timeout is 2 seconds:
!!!!!
Success rate is 100 percent (5/5), round-trip min/avg/max = 0.000/0.000/0.000 ms
```

`0.000 ms` is the model being literal: the echo crossed no link, so the latency model has nothing to add, and a figure
copied from a vendor timer would be an invented measurement. The same rule covers IPv6 (a configured address and the
EUI-64 link-local each port forms for itself) and a `traceroute` to the box's own address, which is one hop. An
address on an administratively disabled port is not answered locally - that port's address goes the routing way and
fails there, which is the state the operator asked for. A neighbour's address is untouched by this: a ping to an
address nobody owns still loses every echo, for `no ARP reply from <address>`.

### A probe that came back as an unreachable

The marks line is one character per echo, and the character says what came back. `!` is a reply, `.` is the timeout
expiring with nothing received, and `U` is an ICMP destination-unreachable: a router on the path with no route for
the destination answers the echo with type 3, and that is a different fact from silence. The vendor keeps the two
apart in its own output-character table - `U` "A destination unreachable error PDU was received", `.` "the network
server timed out as it waits for a reply" - and the same page's worked example prints `U.U.U` for a **code 1** (host
unreachable) answer, so the letter is not per code the way `traceroute`'s `!H`/`!N` are
(research/ping-unreachable-letter.md).

```
R1# ping 192.0.2.10 3
Type escape sequence to abort.
Sending 3, 100-byte ICMP Echos to 192.0.2.10, timeout is 2 seconds:
UUU
Success rate is 0 percent (0/3)
% Echoes lost: 3 drops ("no route to 192.0.2.10 (dropped by r2)" x3)
```

There is no per-echo sentence under a `U`, or under the `.` that stands for a timeout: a box prints the marks and
the success rate and nothing between them, and this console prints nothing there either. The `% Echoes lost:` line
is this console's own voice and stays, because it is the only part that says *which* box could not route. A box
that cannot route the echo **itself** - a source-side `no route` - is a separate case the evidence does not settle,
and is left as a timeout; the research note says why.

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
% Echoes lost: 1 drop (no ARP reply from 10.0.0.99)
```

The per-echo `Request timed out (seq n)` line is gone with the `Reply from` lines it used to sit beside: a box
prints no sentence per echo, and the `.` on the marks line is where the expiry was already reported.

Four echoes are one statement about the path, not four; the count lives in the sentence:

```
r1> ping 10.0.0.10 4
Type escape sequence to abort.
Sending 4, 100-byte ICMP Echos to 10.0.0.10, timeout is 2 seconds:
....
Success rate is 0 percent (0/4)
% Echoes lost: 4 drops ("peer port shut (r2 Gi0/0/0)" x4)
```

The phrasing is the one the port counters already used — `3 drops (no route to 10.0.0.99 x2, link down)`, longest
reason first, `xN` for a repeat, reasons past the third counted rather than hidden — and it lives in one function,
`Simulator`'s `dropsSentence()`, which `show interfaces` and `ping` both call. A reason that brings its own brackets
is quoted (`"ACL 101 denied (in)"`), so the list stays one level deep for a reader and does not end early for a
parser.

Two silences are deliberate. A path that is **still converging** is not loss and keeps its own sentence (`% Still
converging: stp on s1 (ready at 30000 ms)`), never both. And a failure with **no recorded reason** prints nothing
extra: the `.` on the marks line already said what happened, and inventing a cause for it would be worse than the
gap.

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
% destination not reached after 1 hop
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

The hop number is a fixed field: three characters, right-aligned, so `  1` and ` 10` start their address in the
same column and a trace that crosses ten routers still reads as a table. Two captured IOS-XE traces print it that
way - hops 1-15 (`  1 192.168.173.43` above ` 10 108.224.66.161`) and hops 1-12 (`  1 10.1.1.4 [AS 65515]` above
` 10 10.1.1.4 [AS 65515]`) - and this console used to print one space and then the number, so every hop from 10 on
moved its address, and every probe column behind it, one character right. The separator after the number is still
this console's two spaces where the box prints one; `research/traceroute-hop-line.md` carries both captures and
says why only the field width was changed.

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

### The hop limit

`max <n>` is the cap on how far the walk goes, and it is the number a technician lowers to keep a trace inside the
part of the network they are debugging:

```
r1#traceroute 10.0.3.9 max 2
Type escape sequence to abort.
Tracing the route to 10.0.3.9
  1  10.0.1.254  0.002 msec  0.002 msec  0.002 msec
  2  10.0.2.2  0.103 msec  0.103 msec  0.103 msec
% destination not reached after 2 hops
```

The cap stops the walk at the TTL it names, so no probe is sent beyond it and no hop beyond it is printed. A cap at
or above the path length changes nothing: `max 30` and `max 255` print exactly what the bare command prints. The
range is the vendors' — 1 to 255 — because that is what a `traceroute` hop limit accepts (Cisco 13730's
`Maximum Time to Live [30]`, the CBS 250/350 reference's `ttl max-ttl ... (Range: 1-255)`, the ASR 5000 reference's
`maxttl` "an integer from 1 through 255"). A value outside it, a missing value, a second `max`, or any other word
after the target is refused by name rather than ignored: `traceroute 10.0.0.1 5` used to answer a question about a
five-hop trace with a thirty-hop one.

What a box prints after the last hop of a capped trace is nothing — Cisco 13730 says the command "terminates when
the destination is reached or when this value is reached", and no reference shows a closing line — so the hop rows
are the whole vendor-visible output. The `% destination not reached` sentence above is this console's own summary
of an unfinished walk (it appears for a pulled cable too, see above); it is printed for a capped trace as well,
with the count of hops actually walked.

`research/traceroute-hop-cap.md` gathers the references, the two spellings this console does not adopt
(`ttl <max-ttl>` and `ttl <min_ttl> <max_ttl>`) and what is still open.

### Reading DHCP

DHCP has been modelled end to end since it was: pools, ranges, exclusions, reservations, lease times, renewals
and expiry. The server keeps an allocation table — which MAC holds which address, and when it comes back — and
until now **nothing could read it**: there was no `show ip dhcp` at all. You could build a pool and not find out
whether a single address had been handed out.

```
r1> show ip dhcp binding
Bindings from all pools not associated with VRF:
IP address      Client identifier / MAC          Pool              Expires in
192.168.10.100  02:00:00:00:01:00                lan               3540s (0:59:00)
192.168.10.105  02:00:00:00:00:0a (reserved)     lan               3595s (0:59:55)

2 active binding(s); the lease clock runs from the instant the lease was granted
```

The title line is the box's, and it is printed above the table whether or not a row follows it — it names which
pools the rows came from, and a box writes `Remembered bindings from all pools not associated with VRF:` when
the criterion is the remembered table instead
([research/show-ip-dhcp-binding-title.md](../research/show-ip-dhcp-binding-title.md)). The columns under it are
this console's own: a real box prints a three-deep `Client-ID/ Hardware address/ User name` header, an absolute
`Lease expiration` and a `Type`, where this table keeps the pool attribution and a countdown.

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
`ip ospf cost | area | priority | passive` — and the engine turns those into adjacencies, an SPF tree and
installed routes.

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
2.2.2.2           1   FULL/DR         00:00:40    10.1.0.2        GigabitEthernet0/0/0

1 neighbour(s), all Fully adjacent
```

The six columns are the device's, in its order and at its own columns - Neighbor ID, Pri, State,
Dead Time, Address, Interface - so a reader who knows the command finds the priority and the
countdown where they belong instead of the port under `Address`. **Interface** names the port in
full (`GigabitEthernet0/0/0`, not the panel's `Gi0/0/0`), as every paste of this command does: the
capture the widths were measured on reads `Port-channel1` and `Vlan1000`, Cisco's `13688-16` reads
`Ethernet0`, and the Cisco Press OSPFv2 chapter reads `GigabitEthernet0/0/1`. That makes the row 86
columns wide on a GigabitEthernet port, and nothing wraps it - the box prints it that way too. The
abbreviation is what `show ip ospf interface` prints in this console - its `Interface` column reads
`Gi0/0/0` - so the family's two views spell the same port differently, as a box's do between this
command and its `show ip ospf interface brief`. That `brief` view is the box's table and this console
has none of it: the word was read as a port name and refused with `% No interface brief on r1`, the
sentence a typo gets, and it now answers as a view named in full - the header the table would print,
`Interface    PID   Area            IP Address/Mask    Cost  State Nbrs F/C`, and the one cell no
other view stands in for, the PID, which comes from `router ospf <pid>`, a command this console does
not have. `research/show-ip-ospf-interface-brief.md` has the captures, the measured widths and which
of the seven cells the engine could fill. **Pri** is the neighbour's Hello priority - the value
configured on the *far* port with `ip ospf priority <0-255>`, default 1. It is the same number the
role in the State cell was decided by, taken from the same neighbour record, so the two columns
cannot disagree. **Dead Time** is the Router Dead Interval
counting down from the neighbour's last Hello, and it comes from `convergence.ospfTimers()` - the
same timers the OSPF schedule converges on, not a second table - so a converged table prints the
whole interval (00:00:40 over the default 10 s hello) and a run stopped 15 s in prints 00:00:35.

**State** is two facts in one cell, the way IOS prints it: the adjacency's state, then the role the
**neighbour** holds on that segment. A broadcast segment elects a designated router and a backup -
highest interface priority first, then highest router ID (Cisco's `ip ospf priority` usage guidelines;
RFC 2328 §9.4) - so with both ports at the default 1 across a cable the higher router ID is the DR,
and reads `FULL/DR` from the other end, which is itself the BDR. A port configured at priority 0 is
ineligible for either role: the other end takes the DR alone, there is no second candidate and so no
BDR, and the priority-0 box still reaches `FULL/DR` because a DROTHER synchronises with the DR. With
*both* ends at 0 no DR exists at all; a real pair stops at `2WAY/DROTHER` and carries no route, and
this console - which has no two-way state - refuses the link and prints that reason rather than a
`FULL` the hardware cannot produce. The cell travels with the neighbour and not with the box doing
the looking: a router in the middle of a chain reads `FULL/BDR` on one port and `FULL/DR` on the
other. A serial line's default OSPF network type is point-to-point, where no election runs at all,
and the box prints `FULL/ -`; `ip ospf priority` is accepted and stored there (IOS accepts it too)
and changes nothing. The cell used to say `Full` - one word where the hardware prints a state and a
role, which described a segment where nobody had stood for election.
`research/show-ospf-neighbor-state.md` has the sources and what is still unmodelled (`ip ospf
network`, a third speaker on one segment); `research/ospf-neighbor-table-layout.md`
has the column order, the measured widths and what the countdown cell still cannot show. The heading
above the rows is written for rows: a box with no adjacency answers this command with nothing at all -
no header, no blank line, no count - so an empty table here prints the console's one-line reason and
no heading (`research/show-ospf-neighbor-empty-output.md`).

```
r1> show ip ospf interface
Interface   IP Address       Area  Cost  Cost from   Pri Adjacent  Passive
Gi0/0/0     10.1.0.1/24      0     25    configured  200 yes       no
Gi0/0/1     192.168.1.1/24   0     1     link rate   1   no        yes
```

`Pri` is the port's own Hello priority - the value `show ip ospf neighbor` prints beside the other
end, and the first term of the DR election - so a box that set it can read it back without looking
across the cable.

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

`show ip ospf neighbour <port>` and `show ip ospf interface <port>` narrow to one port, and say where the port
you asked about stands:

```
r1> show ip ospf neighbour Gi0/0/1
% Gi0/0/1 is passive: it advertises its prefix and forms no adjacency
r1> show ip ospf interface Gi0/0/2
%OSPF: OSPF not enabled on GigabitEthernet0/0/2
```

The second answer is the box's, not this console's: where OSPF is not on the port, a router prints one tagged
system message, names the port in its long type spelling, and does **not** say why - an unaddressed port, an L2
access port and a port a `network` statement never covered all draw the same line
(`research/show-ospf-interface-not-enabled.md` has the captures). The reason is still readable in
`show ip interface brief` and `show running-config`, which is where an operator goes next.

A *shut* port is a different answer, because it is a different fact: it is still an OSPF interface, and a box
prints its block - not a message. The block opens with the port's own state line and the address and area:

```text
r1> show ip ospf interface Gi0/0/1
GigabitEthernet0/0/1 is administratively down, line protocol is down
  Internet Address 10.2.0.1/24, Area 0
```

Two captures, a lab loopback and an IOS 12.4 router (`research/show-ospf-interface-shut-port.md`), agree on
those two lines and on their indentation. The block continues with `Process ID`, `Network Type`, `Cost`, `State
DOWN` and the DR/BDR and timer lines; this console stops after the two lines whose facts it holds, rather than
printing numbers it would have to invent. A shut port with **no address** cannot be in OSPF at all and draws the
tagged `%OSPF:` line above. (The *reason* a port is down is not in either answer - it is in
`show interfaces`.)

An access switch has no OSPF at all, and says so rather than printing an empty table:

```
sw1> show ip ospf
% OSPF is not enabled (use "ospf router-id <ip>" in config mode)
```

### The voice VLAN

```
interface GigabitEthernet1/0/5
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

A `remove` that empties the list is committed, not refused: a trunk carrying no VLAN is a state a switch can be put
in, and the subtraction stores it exactly as `none` does. A `remove` on a trunk that still allows the default `all`
is not refused either, because a switch subtracts from it; the remainder prints the way the box prints a list, runs
folded into ranges — but only a run of **three or more**: `157,158` is two ids, because `157-158` is no shorter, and
three captures of the backup line show it ([research/trunk-allowed-two-id-run.md](../research/trunk-allowed-two-id-run.md)):

```
sw1(config-if)#switchport trunk allowed vlan remove 10
Trunk on Fa0/1 allows VLANs 1-9,11-4094 (removed 10)
```

The list always holds **VLANs 1002-1005**, the four FDDI and Token Ring defaults. They are ordinary members of a
trunk's allowed list - the device's default list is `1-4094` and a switch refuses to remove them - so a removal
subtracts the other ids and the printed remainder runs straight through the block, which is what a c3550 does:

```
sw1(config-if)#switchport trunk allowed vlan remove 5-10,12
Trunk on Fa0/1 allows VLANs 1-4,11,13-4094 (removed 5-9,12)
sw1(config-if)#switchport trunk allowed vlan add 7
Trunk on Fa0/1 allows VLANs 1-4,7,11,13-4094 (added 7)
sw1(config-if)#switchport trunk allowed vlan remove 1002
% VLANs 1002 stay on every trunk: the four media defaults (1002-1005) are always allowed and cannot be removed
```

The tail names the ids **this** list lost, not the range that was typed: VLAN 10 was removed in the block above, so
the same line on an untouched default list - the c3550's, which is where the transcript comes from - reads
`(removed 5-10,12)` and here reads `(removed 5-9,12)`. `engine/cli.js` prints the ids the port was carrying
(`gone`), so a request cannot report a subtraction that did not happen.

They can be *named* in the list, and only there: `switchport trunk allowed vlan 1,100,1002-1005` is a line real
Catalyst configurations carry. An access, native or voice VLAN still cannot be one, because those VLANs' media is
Token Ring/FDDI and no Ethernet port can join them — `switchport access vlan 1002` stays refused. The column that
mattered was the allowed list, and it was the one place the console applied the wrong rule
([research/trunk-allowed-reserved-vlans.md](../research/trunk-allowed-reserved-vlans.md)).

The word in front of the list is read as a word. A list typed with spaces or with spaced ranges still parses
(`10, 20` and `40 - 42` are `10,20` and `40-42`), and anything that is neither a verb nor a list is quoted back
with the forms the command takes:

```
sw1(config-if)#switchport trunk allowed vlan banana
% Unrecognized "banana": this console takes a list (10,20), a range (10-20), "all", "none", "add <list>", "except <list>" or "remove <list>"
sw1(config-if)#switchport trunk allowed vlan add
% Incomplete command: switchport trunk allowed vlan add <list>
```

`except <list>` is the third verb, and it is the one that is not an edit. A vendor's vlan-list grammar is
`all | none | [add | remove | except] vlan-atom`, and `except` "lists the VLANs that should be calculated by
inverting the defined list of VLANs" — so it replaces the list with everything the named ids are not, over the
whole 1-4094 a trunk's default list covers, whatever the port was carrying before. The CCNP lab that uses it
prints the answer this console now gives:

```
sw1(config-if)#switchport trunk allowed vlan except 1,999
Trunk on Fa0/1 allows VLANs 2-998,1000-4094 (all but 1,999)
```

The run passes straight through 1002-1005 for the same reason a removal's remainder does: the four media defaults
cannot come out of a trunk, so a list that names one is answered with that rule instead of performed. A list that
would invert the whole id space leaves only those defaults, and that state is committed - a trunk carrying nothing
is a state a box can be put in, as `none` shows:

```
sw1(config-if)#switchport trunk allowed vlan except 1002
% VLANs 1002 stay on every trunk: the four media defaults (1002-1005) are always allowed and cannot be removed
sw1(config-if)#switchport trunk allowed vlan except 1-4094
Trunk on Fa0/1 allows VLANs 1002-1005 (all but 1-1001,1006-4094)
```

The line the backup prints is the computed list, not the word `except` - `switchport trunk allowed vlan
2-998,1000-4094` - so a saved board restores the same set by the path the other forms use
([research/trunk-allowed-except.md](../research/trunk-allowed-except.md)).

`none` is the command's second single-word list, and the one that reaches the empty list without arithmetic.
It is how an operator stops normal VLAN traffic on a link without shutting the port, so it is accepted and prints
the state back in the same sentence:

```
sw1(config-if)#switchport trunk allowed vlan none
Trunk on Fa0/1 allows no VLANs
```

A subtraction reaches the same empty list, and stores it the same way: `remove 10,20` on a trunk allowing only
`10,20` answers `Trunk on Fa0/1 allows no VLANs (removed 10,20)` and the backup writes `switchport trunk allowed
vlan none`.

The word is stored as an empty list rather than as a word: `show interfaces` reads `allowed none`, and the
backup writes the line an operator typed - `switchport trunk allowed vlan none` - so a saved trunk returns as
a trunk that carries nothing, while `no switchport trunk allowed vlan` restores `all`. The keyword belongs to
the later images: the vlan-list form reads `all | none | [add | remove | except] vlan-atom` in IOS
15.x/16.x/17.x, where the 12.2 SE book for the 2960 has `{add | all | except | remove}` and no `none`
([research/trunk-allowed-vlan-none.md](../research/trunk-allowed-vlan-none.md)).

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
`show running-config` writes the folded ranges `switchport trunk allowed vlan 1-9,11-4094`, and
`show interfaces` repeats them as `switchport: trunk · native 1 · allowed 1-9,11-4094`.

One last line, because it is the reason the removal arithmetic looks the way it does: 1002-1005 are in every
allowed list, so `remove 1-1001,1006-4094` leaves only them - and that list is committed, because the same state
is reachable on purpose with `none` (`Trunk on Fa0/1 allows VLANs 1002-1005 (removed 1-1001,1006-4094)`). A
`remove 1-4094` names the whole id space, the pinned defaults survive it, and the backup writes `switchport
trunk allowed vlan 1002-1005` for either form
([research/trunk-allowed-remove-everything.md](../research/trunk-allowed-remove-everything.md)).

### NAT: configuring it, and reading what it did

```
interface GigabitEthernet0/0/1
  ip nat inside
exit
interface GigabitEthernet0/0/0
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
configure any of them** — `config.nat` had no writer, so a lab could not ask the question at all. Six spellings
create a rule:

| command | rule |
|---|---|
| `ip nat inside source static <local> <global>` | one-to-one, both directions |
| `ip nat inside source static <local> <global> tcp <port>` | port forwarding, TCP |
| `ip nat inside source static <local> <global> udp <port>` | port forwarding, UDP |
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

Each of the three is one answer, so a word after it is refused rather than dropped:

```
% show ip nat translations does not take "flurbish": every translation in the table is printed
% show ip nat rules does not take "flurbish": every rule is printed, one line each
% show ip nat statistics does not take "flurbish": every counter is printed
```

The table ends where a box's table ends: with the box's own sentence, `Total number of translations: N`, after
the last row. An empty table is that sentence **alone** - a box prints no headings over nothing - so the view
still says `0` instead of leaving a bare header, and the number is the rows just printed (the model's table holds
only the translations live at the instant asked, so it is also what `show ip nat statistics` calls active):

```
Pro Inside global          Inside local           Outside local          Outside global
icmp 203.0.113.1:1024      192.168.10.50          203.0.113.9            203.0.113.9
Total number of translations: 1
```

Five columns, and the table stops at `Outside global`: the translation's type is **not** a column of the plain
table. Every vendor sample ends at the outside-global address, and a box prints `static` / `extended` only under
`show ip nat translations verbose`, as a `flags:` line under the row. This table used to append the type as a
sixth word; the type is still readable where a box keeps it - `show ip nat rules` prints the rule that made the
entry (with `overload` for PAT) and `show ip nat statistics` counts the rules by type
([research/show-ip-nat-translations-columns.md](../research/show-ip-nat-translations-columns.md)). The protocol
cell is four characters wide, so the inside-global column starts at column 4 as it does in every intact sample;
the three address cells keep this console's own 23 columns, because the documents in hand disagree on their
widths and nothing read here decides between them.

`research/show-ip-nat-translations-total.md` collects the samples: the sentence in the 15M&T, 15S, IOS XE 3S,
16.x and 17.x NAT guides, and the SD-WAN guide's empty case (`show ip nat translations` answering with
`Total number of translations: 0` and nothing else). The 12.4T sample does not print it, so the sentence is
adopted as the modern shape, not as a universal one.

`verbose` is refused in its own words, because it is a real IOS spelling of a *different* table - one row per
translation with each address pair spelled out - and this console keeps no such form. Printing the plain table in
answer to it would have answered a question nobody asked (#2097):

```
% show ip nat translations has no verbose form: every row already carries the inside local and global and the outside local and global addresses, so the plain table is the whole answer
```

### What the MAC table remembers, and for how long

A dynamic entry is where a frame was last seen, and when. Silently, for longer than **300 s**, it is gone: the
`Age` column is the silence, so a run that carries no traffic for five minutes legitimately ends with an empty
table.

```
Vlan    Mac Address         Type        Age     Ports
   1    0200.0000.0100      DYNAMIC     0s      1/1/1
   1    0200.0000.0200      DYNAMIC     140s    1/1/2
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
| udp to the DNS port, 53 (a port-translated entry) | 60 s |
| tcp | 86400 s (24 hours) |
| anything else | 86400 s (24 hours) |

These are Cisco's published defaults (`ip nat translation (timeout)`: `icmp-timeout` 60 s, `udp-timeout` 300 s,
`dns-timeout` 60 s, `tcp-timeout` 86400 s, general `timeout` 86400 s;
<https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/ipaddr/command/ipaddr-cr-book/ipaddr-i4.html>).
`config.nat.timeouts` overrides any of them, and `show ip nat statistics` prints the values in force rather than
leaving the rule to be guessed:

```
Timeouts (seconds): icmp 60, udp 300, dns 60, tcp 86400, other 86400
```

`dns` is not a fourth protocol: the same command reference writes the contrast in one sentence - "When port
translation is configured, ... Non-DNS UDP translations time out after 5 minutes, and DNS times out in 1 minute" -
and the DNS ALG is on as soon as NAT is configured, on port 53. So a UDP entry in the **port-translation** table
whose destination is 53 is a DNS translation and takes the 60-second timer; every other UDP entry keeps 300, and a
simple dynamic entry (no overload) keeps its protocol's timer whatever port the first flow named. `dns` in
`config.nat.timeouts` sets the 60; a `udp` value does not move it. The TCP side of the ALG, a non-default ALG port
and DNS payload rewriting are not modelled - see `research/nat-dns-translation-timeout.md`.

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
Interface           Role Sts Cost      Type
------------------- ---- --- --------- -------
Fa0/1               Desg FWD 4         P2p
Fa0/2               Altn BLK 4         P2p
```

The `Role` and `Sts` cells are the device's table cells, not its detail view: a box prints `Root`, `Desg`,
`Altn` and `FWD`, `BLK` (plus `LTN`/`LRN` while the tree is still converging), and keeps `designated forwarding`
for a detail view this console does not model. The word is refused rather than answered, and the refusal points
at the table that does report the tree:

```
[sw] show spanning-tree detail -> % show spanning-tree does not take "detail": this device's tree is reported - the Interface column names the port each row is about
```

The header, the rule under it and the column positions are a machine-recorded Catalyst capture's, not this
console's own layout: `Interface` in a 20-character field, `Role` 5, `Sts` 4, `Cost` 10, then `Type`
(ntc-templates, `cisco_ios_show_spanning_tree.raw`; the Catalyst 9300 17.12 command reference prints the same
header). The `Cost` cell is the short path cost the election charged that port — 4 for 1 Gb, 19 for 100 Mb — read
from the same per-port record the root-port choice used, so the table cannot price a link differently from the
tree that blocked it.

The `Type` cell is the RSTP link type, which the vendor derives from the port's duplex: "full duplex tells the
switch to use port type point-to-point, with half duplex telling the switch to use port type shared" (CCNA
200-301 Official Cert Guide, Appendix O). So a full-duplex port reads `P2p` and a half-duplex one `Shr`, and two
ends of a duplex mismatch disagree in exactly the way the hardware does. The vendor's other input to that cell,
PortFast, is not modelled here — `spanning-tree portfast` is refused by name — so no row ever says `Edge`; a row
whose port has no duplex answer prints `-` rather than a guessed link type. `Prio.Nbr` is the one column still
missing, because the port number is the platform's interface index and no name here carries it
(`research/stp-port-table-type-column.md`, `research/stp-port-table-cost-column.md`).

The detail sentence is still what the runtime payload and the port tooltip say, because there a sentence is the
right shape; the table uses the words a table uses (`research/stp-port-table-role-and-sts.md`).

The header names the **bridge priority** and the **root bridge the election chose**. Without it the report
described a tree but not why it had that shape: priority decides the election before MAC address does, so two
switches with the same ports and the same cables can produce different trees and the output gave no clue which
one you were looking at. The priority in force is this device's; the root is named by hostname, else by the id
the lab uses — not by the model label, which is the same string on every switch of one kind.

There are three states, and the header says which one you are in:

* **a bridge in a tree** — `root bridge core-sw1 priority 4096`, with `(this bridge is the root)` after the
  priority when you are reading the root itself;
* **a lone bridge** — the election still runs, and answers with the only candidate: itself;
* **a box that is not a bridge** — a router. It prints the box's own one-line answer, `No spanning tree instance
  exists.`, because a router never joins an election and a report that describes one in terms of roots and bridge
  priorities implies it did. The words are IOS/IOS XE's, not this model's: `research/stp-no-instance-wording.md`
  has the captures. (IOS 12.x/15.x routers print the same sentence with a plural — `instances` — and that older
  form is not reproduced.)

A **bundle is one port** in this table, and it is named the way every table cell names one: `Po1`, the short
form `show etherchannel summary` and `show mac address-table` print. The engine keys the tree by an internal
logical name (`lag-1`) because one bundle is one port to the election; that key is not a port name and is never
printed (`research/stp-port-channel-name.md`). Physical ports keep their own spelling, and a bundle whose
members never negotiated is printed as the physical ports, because that is what the tree sees.

The rows run in **port order** — `Gi1/0/1`, `Gi1/0/2`, … `Gi1/0/10` — because that is the order a box walks its
port list, not the order the names sort as strings. This table sorted its keys as text, so a switch with ten or
more ports in the tree printed `Gi1/0/10` before `Gi1/0/2`: an order no capture shows, disproved by a stack
member whose `sh spanning-tree vlan 10` lists `Gi1/0/9, Gi1/0/10, Gi1/0/11` in that order with `Prio.Nbr` 128.9,
128.10, 128.11 beside them. The captures, and the one thing they do not settle (the order between two *types* of
port), are in `research/show-spanning-tree-port-order.md`.

A topology with **no bridges at all has no root**, and `engine/stp.js` answers `null` for it rather than a root
object with a default priority and no identity. That object is how `root bridge undefined priority 32768` reached
the console on the models in the catalogue that are not bridges — 1,026 of the 2,038 when #1399 was fixed,
1,045 of the 2,359 at this tree (counted by asking each model for `show spanning-tree` and reading the ones that
answer `No spanning tree instance exists.`) — the report was naming a hole.

### Setting the root

```
spanning-tree priority 4096
no spanning-tree priority
```

The bridge priority is `0`–`61440` in steps of `4096` (the low 12 bits are the system ID extension), and **lower
wins**. `0` is legal and is the best priority there is. A value that is not a step is refused rather than
rounded, because rounding silently picks a root the operator did not ask for - and it is refused in the box's
own words, the two sentences and the sixteen values a Catalyst prints, eight to a line at its default width:

```
% Bridge Priority must be in increments of 4096.
% Allowed values are:
0     4096  8192  12288 16384 20480 24576 28672
32768 36864 40960 45056 49152 53248 57344 61440
```

The value check does not echo the number it rejected, so neither does this one; the table it prints is the set
`spanning-tree priority` accepts, value for value. Two Catalyst 4500 configuration-guide PDFs keep the Courier
column in their text layer (`0` in a six-character field, so `4096` starts under `32768`), which is where the
spacing comes from; what they cannot settle - the wrap at a wider `terminal width`, and whether the list is
indented - is recorded in [research/stp-priority-step-refusal.md](../research/stp-priority-step-refusal.md). The
range is still this console's own sentence (`% 61441 is not a valid bridge priority: the range is 0 to 61440`),
because the captures are of the *step* check, not of IOS's parser refusing a number out of its `<0-61440>`.

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

The two blank lines are the box's as well: one inside the key, between the `f - failed to allocate aggregator`
text and `M - not in use`, and one above the `Group` header. Both survive in the machine-recorded captures
(`research/etherchannel-summary-layout.md`), which is where they can be seen at all — a PDF or an HTML page
loses a blank line, so a reconstruction from those reads as one solid block.

`Po1(SU)` is the bundle's own flags: `S` Layer2, and `U` in use or `D` down — `Po1(SD)` when no member can
carry a frame, which is the row above saying the same thing about the group as `(D)` says about a member.

With no channel groups the same four pieces print and nothing follows them: both counts read `0`, then the
header and the rule, and no row. This console used to answer `% No link aggregation groups configured` — a
sentence no IOS prints, and one that turned an empty view into an error. A device with nothing in a view still
answers with the view: Cisco's errdisable recovery document opens its port-channel example with a 6500 that has
no groups in use and prints exactly this empty table (`research/etherchannel-summary-layout.md`).

#### A group number narrows the table; the counts stay the box's

The command takes a channel-group number in front of the keyword — the vendor's syntax is
`etherchannel [channel-group-number | {detail | port | port-channel | protocol | summary}]`, and the 2960-X, 9500
and 9200 references all print their example under a heading that names the number. The number is a **filter**:
the key, both counts, the header and the rule are printed as they are over the whole box, and the table keeps the
rows for the group named — one row, on a switch holding two:

```
sw1#show etherchannel 2 summary
Flags:  D - down        P - bundled in port-channel
        I - stand-alone s - suspended
        H - Hot-standby (LACP only)
        R - Layer3      S - Layer2
        U - in use      f - failed to allocate aggregator

        M - not in use, minimum links not met
        u - unsuitable for bundling
        w - waiting to be aggregated
        d - default port
Number of channel-groups in use: 2
Number of aggregators:           2

Group  Port-channel  Protocol    Ports
------+-------------+-----------+-----------------------------------------------
2      Po2(SU)         LACP      Fa0/7(P) Fa0/8(P)
```

Both counts still describe the box, not the selection: a two-group switch answers
`show etherchannel 2 summary` with `Number of channel-groups in use: 2`, and the same command on a switch holding
only group 2 answers `1`. This console used to refuse the number altogether — `show etherchannel 1` answered
`% show etherchannel does not take "1": every group is listed - each group is headed by its number`, which read as
a complaint about a typo and sent an operator who had copied a line out of a vendor document back to the whole
table. A number that names no group leaves the furniture standing with no row, the shape a box with no groups
prints. `research/show-etherchannel-group-summary.md` carries the captures and the two things left open (a
number naming no group, and a number outside the platform's range).

#### The other five views of `show etherchannel` are refused, not faked

`show etherchannel` is six views, not one: after the optional channel-group number the vendor's grammar admits
`detail`, `port`, `port-channel`, `protocol` and `summary`, and each word has its own page and its own sample
(Catalyst 2960-X Layer 2 Command Reference 15.2(2)E, `show etherchannel`). `summary` is the one-line table above.
`protocol` is a block per group - `Channel-group listing:`, then `Group: 1`, then `Protocol: LACP`. `detail`, `port`
and `port-channel` print each member's LACP/PAgP internals and the bundle's counters and timers, and `load-balance`
prints the frame-distribution policy.

This console answered all six with the summary table. For the five it cannot answer that is a wrong answer rather
than a narrow one — the engine keeps no admin/oper keys, no port-state word, no aggregator MAC and no age timers,
and the hash policy it does keep (`hashPolicy` on the group, `engine/lag.ts:235`, `l2`/`l3`/`l3l4`) has no console
verb behind it — so each is refused in one line, naming the word the reader typed:

```
sw1#show etherchannel detail
% `show etherchannel detail` is a view this console does not have: on a box it prints each member port's negotiation state beside the bundle's counters and age timers, and this model keeps neither; `show etherchannel summary` names each group, its protocol and its members.
```

`summary`, `brief` and the bare command still print the table, and a channel-group number still narrows it. A
group number does not rescue a view: `show etherchannel 1 detail` is refused as `show etherchannel detail`, which
is the view without the filter. `show port-channel detail` refuses under that spelling. `protocol` is pointed at
the column that already carries its fact — the `Protocol` cell of the summary — rather than given a second page of
its own, and `load-balance` points nowhere, because no console verb reads or sets the policy - not because there is none
to read. The group carries `hashPolicy` (`'l2'` written when `channel-group` creates the bundle, `engine/cli.js:4348`;
`lag.ts`'s own default is `l3l4`, `engine/lag.ts:239`) and the data path hashes every frame onto one member with it
(`engine/simulator.js:3739`, `selectMember()` at `engine/lag.ts:407`), so the refusal's second clause - `nothing here
hashes a frame across members` - overstates: what is missing is the view and the verb, not the hash.
`research/etherchannel-summary-layout.md` has the syntax table, the `protocol` sample and what is still open.

#### The first member creates the interface

`channel-group` is not only a membership command: on a box it is the command that *builds* the bundle, and it
says so in one line before anything else:

```
sw1(config)#interface Gi1/0/1
sw1(config-if)#channel-group 1 mode active
Creating a port-channel interface Port-channel 1
Interface Gi1/0/1 added to channel group 1 (mode active)
sw1(config-if)#interface Gi1/0/2
sw1(config-if)#channel-group 1 mode active
Interface Gi1/0/2 added to channel group 1 (mode active)
```

The vendor states the rule for the command - "This command automatically creates the port-channel logical
interface when the channel group gets its first physical port" (Cisco, *Catalyst 2960 and 2960-S Software
Configuration Guide*, 12.2(55)SE, "Port-Channel Interfaces") - and a 2955 transcript shows the other half of it:
the receipt on the first member, and no receipt on the second (Cisco, doc 23408). The line belongs
to the *interface*, not to the command, so a member joining a group that already exists prints only the
console's own confirmation, and a command that is refused prints no receipt at all.

The spacing is the vendor's, and it disagrees with the interface's own name: the creation line says
`Port-channel 1`, while `show ip interface brief`, the syslog line for the same interface and
`show running-config` all spell it `Port-channel1` (doc 23408 prints both in one transcript). A 12.1 Catalyst
2950 printed the receipt without the space; the 15.x captures have it, and this console follows them
(`research/channel-group-creating-receipt.md` carries the sources and the variance).

One difference is the model's rather than the box's: this console's bundle exists only while it has members, so
emptying a group and refilling it prints the creation line again. A box keeps `interface Port-channel1` until
`no interface port-channel 1`.

#### A member that negotiated nothing is not in the bundle

A `passive` port answers LACP and never starts it, so two passive ends wait for a partner that neither of them
sends: "A port in the passive mode cannot form an EtherChannel with another port that is also in the passive
mode because neither port starts LACP negotiation" (Cisco, *Configuring EtherChannels*, LACP modes). The bundle
therefore never comes up — `Po1(SD)`, every member `(I)` stand-alone — and the member is **not** lost: the same
chapter's next sentence is that incompatible ports are "put into an independent state" and "continue to carry
data traffic as would any other single link". This model does that, so a ping between a passive/passive pair
still crosses; it crosses over one physical link, because with the bundle gone the spanning tree sees two
parallel links between the two bridges and blocks one of them. Before this the summary claimed `Po1(SU)` with
both members `(P)` and the data plane hashed frames across a bundle no box would have built
(`research/lacp-passive-both-ends.md`).

The same answer covers the other way to lose the negotiation: a far port in **no channel group at all**. LACP
is a conversation, and a port that never configured a channel group never sends or answers an LACPDU —
`channel-group 1 mode active` against a plain access port forms no bundle either, however confidently the near
end announces itself. The 2960 chapter states the outcome: "Incompatible ports are suspended. Beginning with
Cisco IOS Release 12.2(35)SE, instead of a suspended state, the local port is put into an independent state and
continues to carry data traffic as would any other single link. The port configuration does not change, but the
port does not participate in the EtherChannel." So the summary reads `Po1(SD)` with the member `(I)`, the frame
still crosses over that one link, and the spanning tree sees the single link the hardware has
(`research/lacp-one-sided-group.md`).

The letter is `(I)` stand-alone rather than `(s)` suspended because that is what the key above the table says
the two mean, and this model's member is **carrying**: `s` is the flag for a member that is not. IOS XE 17.x
words the same condition as *suspended* and moves the member back out of that state only when LACP standalone
mode is enabled on the bundle — a different behaviour from the one this console claims, and one whose own
default its guide states both ways (`research/lacp-one-sided-group.md` records the split).

`mode on` is the exception the vendor names, and it is not one this model invents: `on` negotiates nothing, so
there is no answer to wait for and the switch forces the bundle up — "in the on mode, a usable EtherChannel
exists only when the switches at both ends of the link are configured in the on mode", and otherwise "packet
loss can occur". A one-ended `on` group therefore still reads `Po1(SU)` with its members `(P)`; each end has
its own opinion of that cable on a real box, which is the asymmetry the research note leaves open.

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
`engine/lag.ts` translates once in each direction, so a lab saved by an older build holding `active` normalises
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

#### A bundle carries eight links; the rest wait as `(H)`

One number, and the console applied none of it: "Each EtherChannel can consist of up to eight compatibly
configured Ethernet ports … For a PAgP EtherChannel, you can configure up to eight ports of the same type and
speed for the same group. For a LACP EtherChannel, you can configure up to 16 Ethernet ports of the same type.
**Up to eight ports can be active, and up to eight ports can be in standby mode**" (Cisco, *Configuring
EtherChannels*, Catalyst 2960-X 15.2(3)E). Ten `channel-group 1 mode active` lines used to build a ten-member
bundle, mark all ten `(P)`, and hash frames across all ten — a switch that moves ten links of traffic, and a
row that agreed with the configuration instead of the hardware.

Now `mode on` holds eight members and refuses a ninth, LACP holds sixteen, and past the eighth the receipt says
what the box would do — on a negotiating bundle, where the ninth and the tenth wait:

```
sw1(config-if)#channel-group 1 mode active
Interface Gi1/0/9 added to channel group 1 (mode active)
  Gi1/0/9 is hot-standby: the bundle already has 8 active links, and this one takes over if an active link fails
sw1(config-if)#exit
sw1(config)#interface Gi1/0/10
sw1(config-if)#channel-group 1 mode active
Interface Gi1/0/10 added to channel group 1 (mode active)
  Gi1/0/10 is hot-standby: the bundle already has 8 active links, and this one takes over if an active link fails
```

The mode belongs to the group, not to the member: a line typed on a port that is already in the group re-modes
every member (`Channel group 1 mode changed from active to on for every member: Gi1/0/1, Gi1/0/2, …`) rather
than refusing the port. The cap is applied on that path too, because a mode change is the one line that rewrites
the cap a group already holds under: ten members fit one LACP group (sixteen), and moving it to `mode on` would
leave them in an eight-link bundle with nowhere to park the ninth or the tenth — hot-standby is `LACP only`, as
the key says — so the mode is what gets refused:

```
sw1(config-if)#channel-group 1 mode on
% Channel group 1 not moved to mode on: it holds 10 members, and a static (`mode on`) bundle carries at most 8 links, with no hot-standby to park the extra 2 in. Keep `channel-group 1 mode active`, or remove a member first. Nothing was changed.
```

Typed on a port the group does not hold, the same line is a join as well as a mode change, and it is refused for
the bundle it would build. `Gi1/0/11` is the eleventh socket of this switch, outside the ten-member bundle:

```
sw1(config-if)#exit
sw1(config)#interface Gi1/0/11
sw1(config-if)#channel-group 1 mode on
% Gi1/0/11 not added: channel group 1 holds 10 members, and `channel-group 1 mode on` would make 11 - above the 8 links such a bundle carries. Nothing was changed.
```

The join refusal names the group's own count and the cap it would breach, so a line that both joins and
re-modes cannot answer with a number the group does not hold.

The table prints the letters the key above it has always printed:

```
1      Po1(SU)         LACP      Gi1/0/1(P) Gi1/0/2(P) Gi1/0/3(P) Gi1/0/4(P) Gi1/0/5(P) Gi1/0/6(P) Gi1/0/7(P) Gi1/0/8(P) Gi1/0/9(H) Gi1/0/10(H)
  Gi1/0/9   hot-standby: the bundle already holds 8 active links
  Gi1/0/10  hot-standby: the bundle already holds 8 active links
  bundle 1 carries 8 active links; Gi1/0/9, Gi1/0/10 hot-standby (one takes over if an active link fails)
```

`(H)` is the key's own letter for that state — "Hot-standby (LACP only)" — and it was unreachable before: no
member of any bundle could be in it. The active eight are the **lowest-numbered** members that can carry
("The hot-standby ports that have lower port numbers become active in the channel first", same chapter), so
port order and not string order decides — `Gi1/0/9` waits behind `Gi1/0/2`, where a name sort would have put
it first. Pull an active member's cable and the first standby is promoted into the row as `(P)`; the bundle
stays eight links wide and the `bundle 1 is running on …` sentence does not appear, because a bundle at full
width is not a bundle running short. `research/etherchannel-member-limit.md` carries the sentences, the
platforms they come from, and what is still open (the device's own wording for the ninth and seventeenth line,
`lacp max-bundle`, and the per-vendor maxima this one global number cannot express).

The data plane uses the same rule: **the hash is taken over the members that can carry** and are in the
channel — never more than eight — so unplugging one member of a two-member bundle does not cost you half your
flows while the other member sits idle, and a hot-standby member never receives a frame. When no
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

The undo takes the group number and **nothing after it** — the vendor's syntax is
`channel-group <n> mode {…}` for the setting form and `no channel-group` for the undo, and a box answers the
two mixed together with its parser's refusal. This console used to read the number and drop the rest, so the
half-remembered line removed the port:

```
sw1(config-if)#no channel-group 1 mode on
% no channel-group takes the group number and nothing after it: the word "mode on" was not used, and nothing was changed
```

The refusal comes before any question about membership, so a port in another group gets the grammar sentence
rather than "is not in channel group …", and a port in the named group keeps its place in it.
`research/no-channel-group-undo-grammar.md` carries the syntax lines and the transcript.

A port belongs to **one** bundle. A second `channel-group` **moves** it, and says where from -
`Interface Fa0/1 moved from channel group 2 to 10 (mode on)`. Before this each line added membership to another
group, so one cable was listed in every bundle it had ever been joined to, which is a state no switch can be in.

The table is ordered by number rather than as strings, so groups read `2, 10, 100`.

### Reading `show power inline`

```
sw1#show power inline
Available:25.0(w) Used:13.0(w) Remaining:12.0(w)
Interface Admin  Oper       Power   Device
                            (Watts)
--------- ------ ---------- ------- -------------------
1/1/1     auto   on         13.0    PD1
1/1/2     auto   power-deny 0.0     PD2
1/1/3     auto   off        -       the far end is not a powered device
1/1/4     auto   off        -       administratively down
20 ports with nothing plugged in: 1/1/5, 1/1/6, 1/1/7, 1/1/8, 1/1/9 (+15 more)
  1/1/2: PSE budget exhausted: 12.95 W requested, 12.05 W left
```

The column names, their widths and the Power cell are the box's, not this console's. A machine-recorded IOS XE
session prints

```
Interface Admin  Oper       Power   Device              Class Max
                            (Watts)
--------- ------ ---------- ------- ------------------- ----- ----
Gi1/0/1   auto   on         30.0    AIR-AP1562I-E-K9    4     30.0
Gi1/0/5   auto   faulty     0.0     n/a                 n/a   30.0
```

and a 2960+ running 15.0(2)SE6 prints the same three heading lines, with rows like
`Fa0/9     auto   on         3.3     IP Phone 7821       1     15.4`
(`research/show-power-inline-columns.md` has both captures).

Both fix the same fields: `Interface` is a 10-character field, `Admin` 7, `Oper` 11, `Power` 8 and `Device` 20;
the unit is a line of its own under `Power` at column 28, not a suffix on every number; and the rule under the
header is one dash shorter than each field. The number in the Power cell is a bare figure to a tenth, the
precision the `Available:/Used:/Remaining:` line above it uses, so a reader who adds the rows up gets the
printed `Used:`.
This view printed its own vocabulary here (`Draw`, `Powered device`, `12.95 W`, no rule, no unit line) until it
was measured against that capture, so a table pasted into a ticket could not be diffed against the one beside
it (`research/show-power-inline-columns.md`).

Two columns of the box's table are missing on purpose. `Class` needs the powered device's IEEE classification,
and nothing in this model negotiates one - a port cabled to a phone would have to print `n/a` where the box
prints `3`. `Max` sits *behind* `Class` in the capture, so printing the watts this catalogue does declare for a
PSE port after `Device` would put a number under a heading it does not belong to. The table therefore stops at
the last column it holds data for - header, unit line and rule all end after `Device` - the rule
`show spanning-tree` follows with `Prio.Nbr` and `Type`.

Every figure comes from the engine's own allocation (`Simulator.computePoe()`), not from a second copy of the
rule, and every PSE port is accounted for — including the ones the engine leaves out of its table, which are the
ones an operator is usually asking about. The summary line is the box's own: a standalone Catalyst opens
`show power inline` with `Available:<n>(w) Used:<n>(w) Remaining:<n>(w)` above the port table, to one decimal,
and `Remaining` is `Available - Used` on the printed values (`research/show-power-inline-summary-line.md`).
It is the device's, so `show power inline <port>` does not print it:

* `Oper` carries the vendor's four operating states — `on`, `off`, `faulty`, `power-deny` — so a port that
  **detected a powered device and could not supply it** reads `power-deny`, not `off`: the field table defines
  `off` as "No PoE is applied", the word a socket with nothing on it prints, and the two are different answers
  to "is anything out there". `Power` on such a row is `0.0`, because the column is the power **allocated**;
  what the device asked for is in the sentence under the table, which is the same one the timeline emitted for
  the `poe-deny` event rather than a re-rendering of the same arithmetic
  (`research/show-power-inline-power-deny.md`);
* `Admin` is the port's PoE **administration mode**, not the link's: the vendor's field table reads
  "Administration mode: auto, off, static", `auto` is the factory default, and `off` is what
  `power inline never` leaves behind. This console has no `power inline` command, so every PSE port is `auto` —
  including a shut one, whose shutdown is carried by `Oper off` and by the reason column. `up`/`down` is the
  link's word and used to be printed here, which made a shut port read as though its PoE mode had been set;
* a port with a cable but no powered device behind it says so, rather than looking like a port that works. This
  is the one cell that does **not** speak the box's vocabulary: a real switch prints `n/a` in `Device` for every
  port that detected nothing, which is three different situations here - nothing plugged in, the far end is not
  a powered device, the port is shut. The reason is printed where a reader looks for it, and the `Power` cell
  keeps the box's mark for "no allocation record" (`-`);
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
C   10.0.0.0/24 is directly connected, GigabitEthernet0  (down: link down)
S   172.20.0.0/16 [1/0] via 10.0.0.1  (down: link down)
```

A connected route or a static route stays listed when its port goes down — they are configuration, not
learned facts — but a row that reads as a working path while every packet to it is dropped is the defect. The
mark comes from the same helper `show arp` and `show mac address-table` use for the same port.

Learned routes behave differently, on purpose: an OSPF or BGP route whose session or adjacency is gone is
**withdrawn**, because the protocol would withdraw it. A router does not keep advertising a path it learned
over a cable that has been pulled.

### Reading `show ip bgp`

```
Neighbor         V  AS      State/PfxRcd    Reason
10.0.0.1         4  65001   Idle            egress Gi0 cannot carry a frame (link down)

0 of 1 neighbour(s) established
0 prefix(es) installed from BGP
```

The last cell is the box's own column, and it holds two different kinds of value. While the session is up it
is the **number of prefixes received** from that neighbour — one per prefix the peer sent, whether or not a
better path from elsewhere keeps it out of the forwarding table — and while the session is down it is the
BGP finite-state-machine word (`Idle`, `Active`, `Connect`, `OpenSent`, `OpenConfirm`). No IOS image prints
the word `Established` in this table: Noction's state guide says it in as many words, *"you won't see the word
'Established' in the output of the show … summary command: rather, you'll see the number of prefixes
received from the neighbor"* ([Debugging BGP
states](https://www.noction.com/blog/debugging-bgp-states)), and Dell's command reference for the field says
the same ([`show ip bgp summary`](https://www.dell.com/support/manuals/en-lt/dell-emc-os-9/s4048t-on-9.14.2.6-cli-pub/show-ip-bgp-summary)).
A box with no route to the peer reads `Idle` in that cell, which is the word Cisco's own troubleshooting
capture shows for that case ([Troubleshoot BGP Basic
Issues](https://www.cisco.com/c/en/us/support/docs/ip/border-gateway-protocol-bgp/218027-troubleshoot-border-gateway-protocol-bas.html)).
The `Reason` column beside it is this console's own teaching aid and no box prints it; the columns between
(`MsgRcvd`, `MsgSent`, `TblVer`, `InQ`, `OutQ`, `Up/Down`) are not modelled yet
([research/show-ip-bgp-summary-state-cell.md](../research/show-ip-bgp-summary-state-cell.md)).

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

With **no BGP process** the box answers none of these views. It prints one line, and it is the same line for
`show ip bgp`, `show ip bgp summary` and every narrowed form:

```
% BGP not active
```

Not `% BGP is not enabled`, which was this console's own sentence: right about the fact, wrong about the
words. A refusal is what an operator recognises and quotes, so it is copied from the box. No `is`, no full
stop — and the Arista EOS spelling of the same refusal (`% BGP is not active`) is one word different, which
is the reminder that the line belongs to a vendor. Four Cisco captures across three sub-views are in
[research/bgp-not-active-refusal.md](../research/bgp-not-active-refusal.md); the *config-mode* refusals
(`% BGP is not enabled (use "router bgp <as>")`) are unchanged, because they are this console's sentences
for commands it accepts in global config and a box does not — a separate question, recorded there.

With a process configured the views answer — and a word after them that is not one of their own is
**refused**, not dropped. Both spellings used to ignore the tail, so `show ip bgp 10.9.9.0/24`,
`show ip bgp regexp ^65002` and a plain typo all printed the whole table, which is the non-answer
`show ip route <prefix>` gave before #1403: a table with prefixes in it reads as "yes, that prefix is in there".

```
r1#show ip bgp 10.9.9.0/24
% show ip bgp does not take "10.9.9.0/24": every neighbour and every installed prefix are printed - read the row for the prefix under the Network column
```

`show ip bgp` *does* take an ip-address on a box, as a filter, so the refusal is this console's claim about
itself — the same trade `show ip route <prefix>` makes — and it names where the answer is rather than stopping at
no. `show ip bgp summary <word>` refuses the same way. `show ip bgp neighbors` is a view a box has and this console
does not, and it is not called a stray word: it answers `has no detail view here` and points at the neighbour table
(the form `show ip nat translations verbose` takes for the same kind of gap). With **no process** the `% BGP not
active` line is unchanged whatever was typed, because there is no table for a word to be dropped from.

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

A **standard** line carries its action in a seven-column field — `permit` plus one space, `deny` plus three —
so every address in the list starts in the same column; an **extended** line is not padded and prints
`deny ip …` after one space. The field was read off a Cisco Press certification chapter that prints a
standard list and an extended list on the same page, and the raw captures separate the two kinds the same
way (research/show-access-lists-action-column.md).

A **standard** list is the exception, and it is the box's exception, not this console's: IOS rewrites it so
that every entry pinning one address (`host 10.1.1.1`, or `10.1.1.1 0.0.0.0`) sits above the entries that
match a range, and writes the file in that order too — "the switch always rewrites the order of standard
access lists so that entries with host matches … are moved to the top of the list … Therefore, in show
command output and in the configuration file, the ACEs do not necessarily appear in the order in which they
were entered" ([Catalyst 2960-X 15.2(6)E configuration guide](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960x/software/15_2_6_e/configuration_guide/b_1526e_consolidated_2960x_cg/m_sec_acls_cg_cauvery.html)).
So a host entry numbered 20 can print above one numbered 10 and keep its 20, and that is the order packets
are tested in: a range line that would have permitted an address loses to the host line printed above it
(research/standard-ace-host-order.md). Extended lists are untouched and stay in sequence order.

Each rule carries how many packets it has matched, counted at the one place every frame is tested, so
permits are counted as well as denies. A rule that has matched nothing prints **no count at all** — saying
"0 matches" on every line of a twenty-line list is noise, and the absence of a number is the same statement.

Traffic that matches nothing is thrown away by the list's unwritten final `deny any`, and **that drop gets
no line here**, because a box gives it no counter. Cisco puts the rule in one sentence - "Only packets denied by
explicit deny statements are counted, which is why the explicit deny statement will yield more complete data for
you" ([IP Access List Overview, IOS XE 16](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/sec_data_acl/configuration/xe-16/sec-data-acl-xe-16-book/sec-access-list-ov.html);
same paragraph in the 16.9, 3S and 2960-XR 15.2(7)E ACL books) - and two machine-recorded sessions print
counts on the entries that have them with no implicit entry anywhere, one of them a list whose whole body is
empty ([ntc-templates](https://github.com/networktocode/ntc-templates/tree/master/tests/cisco_ios/show_access-list);
research/acl-implicit-deny-counter.md). This table used to invent `  (implicit deny all: 2 matches)`; the
packets are still accounted for, by `show interfaces` (`2 drops ("ACL 101 denied (in)" x2)`) and by the lost
echoes `ping` reports.

Counters are keyed by the rule's own text, so rewriting a list does not re-attribute old traffic to a new
rule that happens to sit at the same position. `no access-list <id>` deletes the counters with the list.

The number here and the `drops (ACL 101 denied (in) x5)` figure on `show interfaces` describe the same
packets; they are read together when working out why something is not getting through.

With no simulation run the table prints `counters: not measured (no simulation run)`; with a run but no
traffic through the list, `counters: no packet has been tested against this list`. Those are different
answers and neither of them is "zero".

### Reading `show lldp` and `show lldp neighbors`

Two commands, two questions, one word apart. This console used to answer both with the neighbour table, which
meant the protocol's *own* state could not be asked for at all:

```
sw#show lldp
Global LLDP Information:
    Status: ACTIVE
    LLDP advertisements are sent every 30 seconds
    LLDP hold time advertised is 120 seconds
    LLDP interface reinitialisation delay is 2 seconds
```

Those five lines are a vendor transcript — a Catalyst 9500 prints exactly this, at this indent, in Cisco's field
notice on unknown-protocol drops
(https://www.cisco.com/c/en/us/support/docs/switches/catalyst-9300-series-switches/224586-troubleshoot-unknown-protocol-drops-in.html),
where the off-case (`lldp run` never typed) is the single line `% LLDP is not enabled`. The three numbers are the
protocol defaults and are read from `engine/lldp.js`, so the status block and the TTL every LLDPDU carries cannot
drift apart: `lldp timer` 30 s × the hold multiplier 4 = the 120 s `lldp holdtime`. Nothing else varies them.

**This model always announces**, so the block always says `ACTIVE`. There is no `lldp run` here and no per-port
`lldp transmit` / `lldp receive`, so there is no state in which the refusal would be honest, and the block states
the model rather than a vendor default it cannot check. Whether a factory-default Cisco switch runs LLDP before
anyone types `lldp run` is genuinely contradictory in the public sources (the configuration guides' default tables
say disabled; field reports from a Catalyst 3750 and Cisco's own field notice transcript say ACTIVE) —
research/lldp-default-state.md lays out both sides and what would settle it. The consequence worth knowing: a port
list that is empty under `show lldp neighbors` is *not* how you find out LLDP is off, because it never is here.

The table itself is the vendor's, column for column:

```
sw#show lldp neighbors
Capability codes:
    (R) Router, (B) Bridge, (T) Telephone, (C) DOCSIS Cable Device
    (W) WLAN Access Point, (P) Repeater, (S) Station, (O) Other

Device ID           Local Intf     Hold-time  Capability      Port ID
ASR 1001-X aggregatiFa0/1          120        R               Gi0
PC-pc               Fa0/2          120        S               eth0

Total entries displayed: 2
```

Five fixed columns — Device ID at 0, Local Intf at 20, Hold-time at 35, Capability at 46, Port ID at 62 — under
a four-line legend and one blank line, and one blank line above the count. The layout is not a reflow of a web
page: it is a preserved IOS capture kept as a test fixture
(`tests/cisco_ios/show_lldp_neighbors/cisco_ios_show_lldp_neighbors.raw` in
[networktocode/ntc-templates](https://github.com/networktocode/ntc-templates)), and the same shape is printed by
the Catalyst 3750 configuration example and by the IOS XR field table. A **Device ID longer than 20 characters is
cut at 20** and runs flush against its port, exactly as the fixture's `long_name_swt.josh-vGi0/2` does; the field
table states the rule ("If the device ID has more than 20 characters, the ID will be truncated to 20 characters
in command output because of display constraints"). The **Capability** column is the System Capabilities TLV's
letters in bit order — `B`, `R`, or both as `B,R` — and is blank when a neighbour advertised no capabilities.
research/show-lldp-neighbors-columns.md has the captures and the mapping.

The table is filled from LLDPDUs that actually crossed a link, not from the topology file, so an empty table
means nothing has announced itself. The management address is still on the neighbour record and on the port's
own block, but it is not one of this view's five columns and no longer printed here: a table whose columns no
box prints cannot be compared with the one pasted beside it in a ticket.

The closing `Total entries displayed: N` is the vendor's sentence, and `N` is the rows the view printed, not
the number of neighbours the box has ever heard. A Catalyst ends its own table with exactly that line, at the
left margin one blank line under the last row; so do NX-OS and IOS XR. `show mac address-table` closes its table the same
way. An empty table gets the same line reading `Total entries displayed: 0` - a Catalyst 9300 asked about a
port with nothing on it prints the heading and then the zero, and so does an IOS router just given `lldp run`
that has heard nothing yet. The count cannot say *why* the table is empty, which is what the sentence above it
is for (research/lldp-total-entries.md).

A neighbour is **not** deleted the moment its link goes down: real switches hold the entry until the
hold time it advertised runs out, and that is what happens here. The box notes the instant it heard each
neighbour (`lldpSeenAt`, beside the record rather than in it, because a clock reading is not something the far
end advertised) and a row older than its own TTL is dropped, so a host that is unplugged or shut stops being
listed about two minutes later — the default 120 s: `lldp timer` 30 s times the hold multiplier 4, which is
IEEE 802.1AB's Time To Live TLV and Cisco's `lldp holdtime` default. Until then the reason rides after the row's
last column, in the same sentence `show arp` and `show mac address-table` use — `(down: link down)`,
`(down: peer shut down)`, `(administratively down)` — because the five box columns above it must stay in their
columns; a fresh LLDPDU from the far end puts the row back and restarts its clock.

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
Internet  10.0.0.1         -          0200.0000.0100    ARPA    GigabitEthernet0
Internet  10.0.0.9         20         0200.0000.0200    ARPA    GigabitEthernet0
Internet  10.0.0.10        -          0200.0000.0300    ARPA    GigabitEthernet0 (down: link down)
```

The first row is the router's own address on `Gi0`: a real box lists its own interface addresses in this table,
and Cisco's field list for the command gives the marker - *"Age, in minutes, of the cache entry; a hyphen (-)
means the address is local"*. The other two rows are neighbours, one aged and one whose port has gone down.

A hardware address prints the way an IOS-family device prints one: three dotted quartets, `0200.0000.0300`,
not the colon-separated form the engine stores, compares and hashes them in. The same rule covers the
`Mac Address` column of `show mac address-table`, the `MAC` on a `show interfaces <port>` block, and the
virtual MAC in `show vrrp` (`0000.5e00.010a`).

* **Type** is the encapsulation the binding was learned over, and it has three values on a real box:
  `ARPA` (Ethernet), `SNAP` (RFC 1042) and `SAP` (IEEE 802.3). Only `ARPA` is reachable here — the
  catalogue carries no Token Ring or FDDI port, the two media SNAP and SAP were for — so the column is a
  constant rather than a guess. It sits between the hardware address and the interface, which is where
  Cisco's own `show arp` field list puts it (research/show-arp-type-column.md).
* **Interface** is the port the neighbour was heard on — where to look next. On a local row it is the port that
  holds the address. It is the interface's **whole name**, `GigabitEthernet0/0`, not the faceplate's `Gi0/0`:
  every published capture of this table spells it out (`GigabitEthernet0/0/6` in the IOS XE ARP guide,
  `Ethernet0/0` in the TAC command reference, `GigabitEthernet0/0/2` in the ASR capture quoted below,
  `FastEthernet0/3/0/6` on a CRS router), so this console expands the stored panel name for the cell exactly as
  `show ip interface brief` does - the tables that abbreviate are the ones the vendor abbreviates
  (`show vlan`, `show etherchannel summary`, the MAC table). `research/show-arp-interface-spelling.md`.
* **A hyphen in Age (min) means the address is local.** Every interface holding an IPv4 address gets one row of
  its own: the interface's MAC in Hardware Addr, its name in Interface, and `-` where an age would be. It is not a
  neighbour, it is not aged, and it does not disappear when the port goes down — the address is still configured
  on the box. A host gets no such row: an end station's cache holds its neighbours, not itself
  (`research/show-arp-local-address.md`).
* **A VRRP group's address is local on the master, and is printed as such.** The elected master answers ARP
  for a group address with the group's virtual MAC (`0000.5e00.01xx`), so the address is its own by the same
  test: `Internet  10.0.0.254  -  0000.5e00.0101  ARPA  GigabitEthernet0/0/0`. Cisco checks a first-hop group by reading
  exactly this row - its HSRP guide prints `Internet 10.2.0.20 - 0000.0c07.ac01 ARPA Ethernet0/2` - and a VRRP
  sample shows the same shape with the `0000.5e00.01xx` MAC (`research/show-arp-vrrp-virtual-address.md`).
  A backup prints no such row: what a real backup holds is learned from the master's gratuitous ARP, and this
  model does not install addresses from an unsolicited ARP, so it prints nothing rather than a binding it never
  received. Where the group address is also an interface address (VRRP's "IP address owner") there is one row,
  carrying the port's own hardware address.
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
 All    0100.0ccc.cccc      STATIC      -       CPU
 All    0100.0ccc.cccd      STATIC      -       CPU
 All    0180.c200.0000      STATIC      -       CPU
 All    0180.c200.0001      STATIC      -       CPU
 All    0180.c200.0002      STATIC      -       CPU
 All    0180.c200.0003      STATIC      -       CPU
 All    0180.c200.0004      STATIC      -       CPU
 All    0180.c200.0005      STATIC      -       CPU
 All    0180.c200.0006      STATIC      -       CPU
 All    0180.c200.0007      STATIC      -       CPU
 All    0180.c200.0008      STATIC      -       CPU
 All    0180.c200.0009      STATIC      -       CPU
 All    0180.c200.000a      STATIC      -       CPU
 All    0180.c200.000b      STATIC      -       CPU
 All    0180.c200.000c      STATIC      -       CPU
 All    0180.c200.000d      STATIC      -       CPU
 All    0180.c200.000e      STATIC      -       CPU
 All    0180.c200.000f      STATIC      -       CPU
 All    0180.c200.0010      STATIC      -       CPU
 All    ffff.ffff.ffff      STATIC      -       CPU
   1    0200.0000.0100      DYNAMIC     0s      Fa0/1
   1    0200.0000.0200      DYNAMIC     140s    Fa0/2 (down: peer shut down)
  20    0200.0000.0900      DYNAMIC     -       Fa0/1 (vlan mismatch)
Total Mac Addresses for this criterion: 23
```

* **The Vlan cell is a right-aligned field, not a label in column 0.** A learnt entry in VLAN 1 prints `   1`
  and the reserved block's `All` prints as ` All` — the word is a value inside the same four-character field, and
  its right edge sits under the last dash of the heading's `----` rule. The console's `Age` column widens the
  field to eight characters, but the value keeps the device's alignment (right edge in column 3), so the MAC
  column still begins in column 8. A box renders this in a fixed-width field and the browser collapses the
  leading space when a sample is pasted from Cisco's HTML, which is how `All` came to be printed in column 0
  here; `research/mac-table-vlan-cell.md` has the raw captures.
* **The table is titled, ruled and counted, the way the device prints it.** `Total Mac Addresses for this
  criterion: N` counts the rows just printed — so under `interface <port>` it is that port's entries, not the
  switch's, and a view that matched nothing reads `…: 0` rather than losing the line. The underline under the
  headings is the device's own fixed run of dashes (4, 11, 8 and 5 for Vlan, Mac Address, Type and Ports); `Age`
  is this model's column and is underlined to the length of its own name.
* **The twenty `All … CPU` rows above them are the box's, not anyone's traffic.** A real switch forwards CDP's
  two addresses, the `0180.c200.0000`–`0010` group-address run (spanning tree, LACP and LLDP among them) and the
  all-nodes broadcast to its own CPU, so it
  prints them as `STATIC` with `All` in the Vlan cell — they are in no VLAN — and counts them in the total, which
  is why an untouched switch reads 20 rather than 0. Nothing here learned them and nothing can age them out, so
  they appear only in the unfiltered view: they are on no port, and `interface <port>` cannot match one. The
  IOS XE family prints one more, `0180.c200.0021`, which this console does not print for any model
  (`research/mac-table-reserved-rows.md` records the split and the eleven-row sample in Cisco's 2960-X reference
  that is boilerplate shared with third-party manuals, not a transcript).
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
     1    0200.0000.0100      DYNAMIC     0s      Port 1
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

### `switchport` with no keywords is the inverse, and here it changes nothing

A box uses the bare positive form for one job: "To put an interface that is in Layer 3 mode into Layer 2 mode
for Layer 2 configuration" (Catalyst 9300 command reference, IOS XE 16.5.x, Layer 2/3 Commands, `switchport`).
This console has no routed port for it to undo - `no switchport` clears the port's Layer 2 configuration but
leaves the port switching - so the line is answered and changes nothing:

```
sw1(config-if)#switchport
% Fa0/1 is already a Layer 2 switchport: `switchport` returns a routed port to Layer 2 mode, and this console has no routed port - nothing changed
```

It used to fall through the handler's last line, `% Unrecognized switchport command: `, with no word after the
colon - a refusal of a command five vendor references document, in a sentence that named nothing. The bare form
is still not a reset: only `no switchport` wipes a port, so `switchport mode trunk`, a native VLAN, an allowed
list and a description all survive it byte for byte (`test/bare-switchport.test.js`, 23 checks). The LAN Base half
of the question - Cisco says the pair "is not supported" on that feature set, and this console still accepts
`no switchport` on every box that switches - is recorded in [`research/bare-switchport-command.md`](../research/bare-switchport-command.md).

### Static routes: a next hop, or an interface, never a port name in the address field

`ip route` takes three shapes, each of which may carry an administrative distance after it, and every one
of them replays from `show running-config`:

```
ip route 10.9.0.0 255.255.0.0 10.0.0.1          via a next hop
ip route 10.9.0.0 255.255.0.0 10.0.0.1 Gi0/0    via a next hop, out a named port
ip route 10.9.0.0 255.255.0.0 Gi0/0             out a port, with no next hop
ip route 0.0.0.0 0.0.0.0 10.0.0.1 200           a floating static, at distance 200
```

The distance is 1-255, default 1, and it is *the number in that slot* rather than a port name:
`ip route 10.9.0.0 255.255.0.0 10.0.0.1 200` is a route at distance 200. The printer writes it in the order
a config takes back (`[iface] [distance]`), so `ip route 10.9.0.0 255.255.0.0 10.0.0.1 Gi0/0 200` survives
the round trip and a floating static does too. One route carries one distance, so a second number is refused
(`ip route 10.9.0.0 255.255.0.0 10.0.0.1 100 200` answers `% 10.9.0.0/16: unexpected "200" - a route takes
one administrative distance, and it must be 1-255`), and a number outside the range is answered with the
range: `% 10.9.5.0/16: administrative distance 0 must be 1-255 (the default is 1)`
(`research/static-route-distance.md`).

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
S   192.168.9.0/24 is directly connected, GigabitEthernet0  (no next hop: ARP for the destination on that segment)
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

The destination is **one field**: `10.0.0.0/24`, address and mask joined, immediately after the code. It was
printed as an address padded out to fifteen characters with the mask hanging off it — `C   10.0.0.0       /24` —
which laid one table out in two shapes (a `/24` row pushed its mask to column 20, the `/0` default row did not)
and disagreed with the inspector's Routes panel, which has always shown `dest/len`. Every IOS sample joins the
pair: `C 10.44.192.0/24 is directly connected, GigabitEthernet0/0` and `S* 0.0.0.0/0 [1/0] via 10.108.99.2` in
Cisco's [gateway-of-last-resort note](https://www.cisco.com/c/en/us/support/docs/ip/routing-information-protocol-rip/16448-default.html),
`C 10.2.1.0/24 is directly connected, Loopback1` in the [`show ip route` command reference](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/iproute_pi/command/Cisco_IOS_IP_Routing_Protocol-Independent_Command_Reference/IP_Routing_Protocol-Independent_Commands_S_through_T.html).
What IOS pads is the *code*, to a wider field than this console uses; the prefix is never split, because it is
one token read as a whole. `test/show-ip-route-prefix-one-field.test.js` pins the rule on every kind of row
(connected, static, static default, configured gateway, OSPF, eBGP).

The **separator after the prefix is one space**, not two: `C 10.44.192.0/24 is directly connected,
GigabitEthernet0/0`, `S 192.168.1.0/24 [1/0] via 10.44.192.2`. This console printed two, which no IOS or IOS-XE
capture in hand writes. The only two-space run in a real table is the *leading* indent of a continuation row
that carries no prefix of its own — a multi-next-hop or subnetted row, where the bracket starts the line. The
separator was measured byte for byte in
[`research/show-ip-route-field-separator.md`](../research/show-ip-route-field-separator.md), and
`test/show-ip-route-field-separator.test.js` pins it on every row shape. The two spaces before this console's
own `(down: …)` / `(not installed: …)` annotations stay: a box prints no annotation, so that gap marks a
sentence the hardware never wrote.

The **interface is a field of the sentence**, in the box's spelling: the type word is written out
(`GigabitEthernet0/0`, not the `Gi0/0` a table cell uses), and when it follows a next hop it is introduced by
`, ` — `S 10.8.0.0/16 [1/0] via 10.1.2.9, GigabitEthernet0/0`. The command reference prints the same row for a
fully specified static (`P 172.16.4.0/8 [1/0] via 10.1.1.1, BRI0`), and for a protocol route it prints one more
field between the two, the route's age: `O E2 10.110.0.0 [160/5] via 10.119.254.6, 0:01:00, Ethernet2`. This
engine does not track how long a route has been installed, so that field is **left out rather than faked**;
the rest of the row is the vendor's. `test/show-ip-route-interface-spelling.test.js` holds the spelling, the
comma and the absence of an invented age, and `research/show-ip-route-interface-spelling.md` carries the
captures and the half still open.

The **rows come out in address order**, whatever letter stands in front of them. IOS 15.x prints the table
"in the increasing order of all network entries", so a static route to `10.2.0.0/16` is printed between the
connected rows for `10.0.0.0/24` and `10.5.0.0/16`, an OSPF route to `10.7.0.0/16` after them, and the
candidate default `S* 0.0.0.0/0` is the **first** row of the table because 0.0.0.0 is the lowest entry. This
console grouped the view by code instead - every connected/local pair, then every static in the order it was
typed, then the protocols - which put the default last and made a pasted table impossible to diff against a
capture; 12.4 and earlier did not follow this rule either (their display followed an internal hash table, so
the order inside a classful block looked haphazard, and the default could print last), which is why the
command reference's own samples disagree with each other. The 15.x rule is the one this console owes, since
its legend and its `L` rows are 15.x shapes; a stable sort keeps two rows for the *same* prefix in the order
the tie-break decided, so a losing candidate still prints under the row it names
([research/show-ip-route-row-order.md](../research/show-ip-route-row-order.md);
`test/show-ip-route-row-order.test.js` pins the order, the interleaving and the same-prefix case).

The legend is the **image's nine lines**, not one line of this console's own codes: a box prints its whole
code list on every `show ip route`, whether or not a route uses it, and wraps it after `B - BGP`, with the
eight continuations starting at column 7 so every code aligns under the `L`. It therefore defines `RIP`,
`EIGRP`, `IS-IS`, `NHRP` and `ODR` on a switch that has never run them — that is what a capture looks like, and
copying a captured table is the point. `L` local, `C` connected, `S` static, `B` BGP, `O` OSPF and `*` for a
candidate default (the sixth line) are the entries this table's rows actually use; each row carries
`[distance/metric]`. The distance is not decoration: it is half of the rule that picks the installed route
(longest prefix first, then lowest distance), and without it two rows for the same prefix cannot be told apart.
`B` sits before `O` because the box's string does
([Catalyst 2960-L 15.2(5)E, "Configuring IP Unicast Routing"](https://cisco.com/c/en/us/td/docs/switches/lan/catalyst2960l/software/15-2_5_e/config-guide/b_1525e_consolidated_2960l_cg/b_1525e_consolidated_2960l_cg_chapter_0111101.html);
the line breaks and the seven-space indent are measured in
[ntc-templates' raw capture of this command](https://github.com/networktocode/ntc-templates/blob/master/tests/cisco_ios/show_ip_route/cisco_ios_show_ip_route.raw), and IOS XE 16/17 prints a longer block of its own —
`research/show-ip-route-codes-legend.md`).

An interface address is a row of its own, one line under the subnet that holds it:

```
C   10.1.1.0/30 is directly connected, GigabitEthernet0/0
L   10.1.1.1/32 is directly connected, GigabitEthernet0/0
```

The `L` row is the address, as a `/32`, and its job is to be a *receive* entry: a packet for it is handed to the
box itself rather than forwarded to a peer that happens to advertise a longer prefix. Both rows are distance 0 —
"the local routes have the administrative distance of 0 … the same adminstrative distance as connected routes"
— and, unlike the connected route, the local one is never redistributed, which is why an interior gateway
protocol carries networks with their real masks instead of a host route per interface. The one exception is an
address configured with a `/32` mask (a loopback): there the host route "appears in the routing table only as
connected (it has the C flag)", so one row, not two. This console printed only the connected row, so the address
a technician had just typed was missing from the table they were told to check it in, and a ping to the box's own
address succeeded with no row explaining why
([Cisco, *Local Host Routes Installed in the Routing Table*](https://www.cisco.com/c/en/us/support/docs/ip/ip-routing/116264-technote-ios-00.html);
`research/local-route-in-show-ip-route.md` records what is still open, the IOS 12.x table that has no local
routes at all and the classful heading lines this console does not print).

A static route whose next hop is **only an interface** is a different row again: IOS prints it as a
directly connected network, in the same words a connected route uses and with **no bracket and no `via`** —
`S 192.168.2.0/24 is directly connected, GigabitEthernet0/1`, and `S* 0.0.0.0/0 is directly connected,
FastEthernet0` for a default. The `ip route` reference explains why this is not a lie: "When the next hop of
a static route points to an interface, the router considers each of the hosts within the range of the route
to be directly connected through that interface, and therefore it will send Address Resolution Protocol
(ARP) requests to any destination addresses that route through the static route." The bracket is absent even
when an administrative distance was typed, which is the part that surprises operators: the distance still
prices the route for selection (the vendor's own chapter on static routing says "although the routing table
entry indicates 'directly connected', the administrative distance of the static route is still 1"), it is
just not shown on the row. This console printed the bracket with a placeholder next hop instead —
`S 192.168.9.0/24 [1/0] via - Gi0` — a row that named no next hop and priced a metric for it
(`research/show-ip-route-static-via-interface.md`, `test/show-ip-route-static-via-interface.test.js`).
A **fully specified** static (interface *and* next hop) is not a directly connected route and keeps its
`[distance/metric] via <next hop>` row.

The metric is the protocol's own cost for the path, in the format Cisco's `show ip route` reference
states — `[administrative distance/metric]`, where "`[110/2]` means that the route has an administrative
distance of 110 and an OSPF metric of 2". It used to be a literal `0` on every row, so two OSPF paths to
the same prefix read the same. For an `O` row it is the distance to the router that advertises the
network plus that network link's own cost ([RFC 2328](https://www.rfc-editor.org/rfc/rfc2328.txt) §16.1,
second stage), which is why a LAN one gigabit hop away behind a neighbour is `[110/2]` and one two hops
away is `[110/3]`; a configured `ip ospf cost` is a term in that sum, and a loopback's stub link costs 0
(§12.4.1). `S` and `B` rows print `0` in that column: no cost is computed for them here.

The default gets three rows from two mechanisms: a static route, at whatever distance it was typed, and a
**DHCP lease**, whose router a box that routes installs as a default route at distance 254.

| Row | Source | Distance |
|---|---|---|
| `S*  0.0.0.0/0 [254/0] via …` | a DHCP lease (`ip address dhcp`) | 254 |
| `S*  0.0.0.0/0 [1/0] via …` | `ip route 0.0.0.0 0.0.0.0 …` | 1 |
| `S*  0.0.0.0/0 [200/0] via …` | `ip route 0.0.0.0 0.0.0.0 … 200` | 200 |

`ip default-gateway` is **not** one of them, because it is scoped to the non-routing case and this table is the
routing shape. On a box with `ip routing` on, the command is retained in `show running-config` and steers
nothing: a router whose only default is `ip default-gateway 10.0.0.254` still prints `Gateway of last resort is
not set`, and no `S*` row appears. On a box that does not route, the same command is answered by the
host/redirect cache shape below instead of a table. Only a lease's router is a route: the row is read from
`device.dhcpGateway` (`engine/device.js:1446`), which `Simulator.computeDhcp()` fills when the lease carries a
gateway (`engine/simulator.js:1248`), while the typed `config.defaultGateway` is consulted only when
`isL3()` is false (`engine/device.js:1166`, and again where the table's `S*` row is built, `:1440`). The
scoping itself, with the vendor sources, is in
[research/ip-default-gateway-when-routing.md](../research/ip-default-gateway-when-routing.md).

The `[200/0]` row is the floating default: it is a candidate, it is listed, and the `Gateway of last resort is …`
line above the table does not name it while a distance-1 default exists. A static route at distance 255 is a
different case - the vendor rule for that number is that the route is *never* installed - so its row says so
and is excluded from the gateway line.

The asterisk is the device's mark for a **candidate default**, and it belongs to the prefix, not to the
row's origin: every route to `0.0.0.0/0` carries it, and the legend defines it on its sixth line
(`* - candidate default`). A typed static default therefore reads `S* 0.0.0.0/0 [1/0] via …`, which is
the shape Cisco's own gateway-of-last-resort note prints, and so does a default learned by a protocol
(`O*E2 0.0.0.0/0`, `D*EX 0.0.0.0/0`).

What separates two candidate defaults is what separates any two routes: the distance in the brackets. The
`Gateway of last resort is …` line names the one packets actually leave by, so a device holding both shows
the static route (`[1/0]`) there and lets the lease's `[254/0]` row say it is not installed.
Starring only the configured gateway — which is what this console did — put the mark on the one row no real
router keeps in its table and left the route an operator types looking like a plain `S`
(`research/show-ip-route-candidate-default.md`).

A box that routes always answers that question, in one of two forms. With no reachable default it is the
negative one, in the place Cisco's own samples put it — directly under the codes legend, above the first
route row:

```
r1#show ip route
Codes: L - local, C - connected, S - static, R - RIP, M - mobile, B - BGP
       D - EIGRP, EX - EIGRP external, O - OSPF, IA - OSPF inter area
       N1 - OSPF NSSA external type 1, N2 - OSPF NSSA external type 2
       E1 - OSPF external type 1, E2 - OSPF external type 2
       i - IS-IS, su - IS-IS summary, L1 - IS-IS level-1, L2 - IS-IS level-2
       ia - IS-IS inter area, * - candidate default, U - per-user static route
       o - ODR, P - periodic downloaded static route, H - NHRP, l - LISP
       a - application route
       + - replicated route, % - next hop override, p - overrides from PfR
Gateway of last resort is not set
```

The rows below that line carry no **classful group header**. A real box groups the prefixes of one classful
network under `10.0.0.0/8 is variably subnetted, 4 subnets, 2 masks` — or `10.0.0.0/24 is subnetted, 1 subnets`
when every entry in the group shares one mask — drops the prefix length from the rows of a single-mask group,
and leaves a classful-complete route (`S 192.168.0.0/16`) and the default outside every group. This console
prints every row flat, with its prefix, and no header: the grouping repaints every row of the view rather than
adding one sentence, so it is a change of its own. `research/show-ip-route-subnetted-header.md` records the
captures, the rule (key, mask, counts, row shapes) and the one thing the captures disagree about, which is the
indentation.

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
C   10.0.12.0/24 is directly connected, GigabitEthernet0
B   10.0.12.0/24 [20/0] via 10.0.12.2, GigabitEthernet0  (not installed: the C route for this prefix has distance 0)
O   10.3.3.0/24 [110/2] via 10.0.12.2, GigabitEthernet0  (not installed: the B route for this prefix has distance 20)
B   10.3.3.0/24 [20/0] via 10.0.12.2, GigabitEthernet0
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
Type escape sequence to abort.
Sending 1, 100-byte ICMP Echos to 10.0.0.2, timeout is 2 seconds:  (at t=5000 ms)
.
Success rate is 0 percent (0/1)
% Still converging: stp on SW1 (ready at 30000 ms) at t=5000 ms
```

Those are the whole answer, not two lines of it: `Sending 1, … (at t=5000 ms)` names the instant that was
asked, the lone `.` is the one echo that never came back, and `Success rate is 0 percent (0/1)` counts it - the
converging sentence is the last line of a five-line answer. [CONVERGENCE.md](CONVERGENCE.md) prints the same one.

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
form, and `_help()` now carries the row `converge [<ms> | at <ms>]`, which names both. The parser reads
both, and a word that is neither an instant nor `at` is refused by name: `converge 1000 wibble` is
`% Unrecognized "wibble" (converge [<ms> | at <ms>])`, and `converge at`, `converge wibble`,
`converge -5` are each `% Invalid instant: …`. A refusal changes nothing, so the answer you then ask
for is the one you get.

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
and a client picks by the subnet its own interface sits in.

`range` is **optional**, as it is on the box: a pool with a `network` and no `range` serves that whole
subnet, and a `range` narrows it. Every Cisco configuration example here is `ip dhcp pool` + `network`
+ options, and the 850/870 chapter's own `show ip dhcp pool` prints the row `10.10.0.1 - 10.10.0.254`
for a pool that never named a range
([Cisco 850/870, Configuring a LAN with DHCP and VLANs](http://www.cisco.com/en/US/docs/routers/access/800/850/software/configuration/guide/dhcpvlan.html));
see [research/dhcp-range-is-optional.md](../research/dhcp-range-is-optional.md). The gateway is never
offered to a client, whether it falls inside a configured range or inside the derived one.

The pool is validated once, when the sub-mode is left — `network` before `range` is the second
keystroke, not an error. The verdict is phrased as a statement about the **pool**, not about the
command just typed, so a pool that cannot serve says why; the library's error code rides at the end in
parentheses so it is greppable without being the message:

```
R1(config)#ip dhcp pool lan
Created DHCP pool lan
R1(dhcp-config)#default-router 10.0.0.1
R1(dhcp-config)#exit
% Pool lan is incomplete - DHCP pool lan: no network address was given. (E_DHCP_BAD_NETWORK)
```

A client is configured with `ip address dhcp` on its interface. The exchange runs before the first
packet of a run, and the failures are the ones a server really produces — `no-server`, `no-pool`,
`pool-exhausted`, `nak`. See [SIMULATION.md §5.1](SIMULATION.md).

## VRRP (first-hop redundancy)

A group belongs to an interface, so the commands live inside `interface`:

```
interface GigabitEthernet0/0
 ip address 10.0.0.1 255.255.255.0
 vrrp <vrid> ip <virtual-address>
 vrrp <vrid> priority <1-254>        # 100 default; 255 is only ever the address owner's
 vrrp <vrid> advertise <seconds>
 vrrp <vrid> preempt                 # on by default; `no vrrp <vrid> preempt` turns it off
 vrrp <vrid> authentication <text>   # stored, and never used by the election
 no vrrp <vrid>                      # remove the group
 no vrrp <vrid> priority|preempt|advertise   # put one setting back to its default
```

**A `no` that names a setting removes the setting; a bare `no` removes the group.** The interface-mode
handler (`_ifaceMode()`, `engine/cli.js:2565`) reads the vrid, and then the word after it; its `no vrrp`
branch is at `:2650-2695`:

```
R1(config-if)#no vrrp 10 preempt
VRRP group 10 preempt disabled
R1(config-if)#no vrrp 10 priority
VRRP group 10 priority reset to 100
R1(config-if)#no vrrp 10 advertise
VRRP group 10 advertises every 1 s
R1(config-if)#no vrrp 10
VRRP group 10 removed from Gi0/0
```

Each of those three words undoes exactly one line of the group, with the default the vendor's reference
states — `priority` is 100 and `timers advertise` is 1 second — and the group keeps its virtual address,
its other settings, and its place in the election. That is what the device does: `no vrrp <group> preempt`
is the documented way to turn preemption off ("To disable this function, use the no form of this
command", syntax `no vrrp group preempt`, [Cisco IOS First Hop Redundancy Protocols Command Reference,
`vrrp preempt`](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/ipapp_fhrp/command/fhp-cr-book/fhp-v1.html)),
and the configuration guide's sample interface block lists `no vrrp 100 preempt` beside
`vrrp 100 ip 10.1.0.100`. It also mattered here: `show running-config` has always printed
`  no vrrp <vrid> preempt` for a group whose preemption is off, so the console was writing a line it read
back as a deletion — pasting its own config took the virtual gateway with it. Only the bare `no vrrp <vrid>`
removes a group, and a word the console cannot unset (`no vrrp 10 wibble`) is refused by name rather than
read as that bare form:

```
R1(config-if)#no vrrp 10 wibble
% Unrecognized vrrp command: no vrrp 10 wibble (this console can unset: priority, preempt, advertise - `no vrrp 10` removes the group)
```

Two things this does not yet do, so nobody reads more into the receipt than is there. **Nothing reads
`preempt` during an election**: `computeVrrp()` re-elects the group from scratch on every pass, and the
one function that models a rejoining router with preemption off (`groupState()`, `engine/vrrp.js:408`)
is called only by the tests. A group with preemption off therefore behaves, so far, exactly like one
with it on. And **`show vrrp` has no column for it** — the vendor prints `Preemption is disabled` in
the detail view and a `Pre` column in `brief`. See
[research/vrrp-no-form-scope.md](../research/vrrp-no-form-scope.md) for the evidence and for what would
settle the display question.

**`authentication` is a sub-word of `vrrp`, and the list above only now names it.** `vrrp <vrid> authentication
<text>` is accepted inside an interface and answers `VRRP group <vrid> authentication set`, and
`show running-config` prints the text back, so a saved lab keeps it:

```
R1(config-if)#vrrp 1 authentication secret
VRRP group 1 authentication set
```

Nothing reads it. `show vrrp` has no column for it, and the election never compares two groups' texts -
VRRPv2 authentication is absent here beyond storing the text, as [SIMULATION.md](SIMULATION.md) says. The
stored value is the **first eight characters**, VRRPv2's field width: `vrrp 1 authentication
averylongsecret` is accepted without a word about the rest and comes back from `show running-config` as
`vrrp 1 authentication averylon`, so a pasted-back config carries the shortened text rather than the typed
one. A line with no text at all - `vrrp 1 authentication` - is accepted too, says the same sentence, and
stores nothing, so no `authentication` line appears in the config afterwards. The VRRP row in `help` stops
at `preempt` and does not name this spelling; the console accepts it, so this page does.

The virtual address has to be **in the interface's own subnet** — a gateway address is only a gateway for
hosts on its wire. Anything else is refused and no group is created:

```
R1(config-if)#vrrp 42 ip 10.0.0.254
% 10.0.0.254 is not in the subnet of Gi0/0 (10.9.9.1/24)
R1(config-if)#vrrp 42 ip 10.9.9.254
VRRP group 42 on Gi0/0 owns 10.9.9.254
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

* **Pri** is the priority the group runs at, which is not always the number that was typed. VRRP
  reserves 255 for the **address owner** - the router whose own interface address is one of the
  group's virtual addresses - so that router runs at 255 however it is configured, and the column
  prints 255 with a note saying why. Every other router prints its configured priority. The value is
  not typeable: `vrrp <vrid> priority` accepts 1-254, because typing 255 would claim an ownership the
  router does not have. A router that owns the address and was configured 150 therefore shows `255`
  here and `vrrp 7 priority 150` in `show running-config`, which is the difference between what the
  group votes with and what was asked for.
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
a real lab, and types each form at a router and a switch — 95 forms, 190 commands today, including the
`show ?` and `show ipv6 ?` examples in the section on the help key and the six uppercase spellings of views that the
case rule made legal (`show ip ROUTE` and its five siblings), each typed as a form of its own — and fails on the
three answers that mean the documentation and the parser disagree: `% Invalid show command`, `% Unrecognized …`, or a throw.

A *legitimate* refusal is not a failure, and the distinction is the whole point: a box with no OSPF configured has no
`show ip ospf` to give and says so in a sentence (`% OSPF is not enabled (use "ospf router-id <ip>" in config mode)`),
which means this page is right and the box is the wrong one to ask. One hundred and eighteen of the 190 answers are refusals of
that kind today, and none of them complains about the command itself. All three numbers are printed by the guard on
every run, so they are a reading of it rather than a memory of it.

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

The traceroute row in `help` reads `traceroute|tracert <address|name> [max <1-255>]`, and both halves are real:
`traceroute srv.lab` resolves through the lab's DNS and prints the lookup and the double target line a box prints
("Tracing a name"), and `max <n>` caps the walk ("The hop limit"). A parameter the index advertises and the parser
never reads is the same defect as a verb the index omits, one word deeper: until November 2026 this row's `max <n>`
was swallowed in silence and every trace ran thirty hops.

The opposite gap sits one word deeper, where the guard cannot look. The index row for a trunk's allowed list reads
`switchport trunk allowed vlan <list|all>`, and the console also takes `add <list>`, `remove <list>`,
`except <list>` and `none` ("A trunk's allowed list is edited in place: `add` and `remove`", and `except`, the verb that
replaces the list instead of editing it); `switchport voice vlan <id>` - the line that puts a phone on its own VLAN,
prints in `show running-config` and survives a saved board ("The voice VLAN") - has no row in the index at all.
`test/help-completeness.test.js` compares the *first word* of a line against the dispatcher's vocabulary, and
`switchport` is in it, so nothing after that word is visible to the check: #1491's sweep was written against verbs, and
these are keywords it left behind. All of them are accepted by the console today, so this page records them rather
than promising they are indexed; the index is the code's to complete.

One whole mechanism is missing from the index, and it is invisible to the same check for the same reason: **NAT**.
The config lines `ip nat pool <name> <start> <end> netmask <mask>` and `ip nat inside source …`, an interface's
`ip nat inside` / `ip nat outside`, and the three views the NAT section reads (`rules`, `translations`,
`statistics`) are accepted today, and `help` names none of them - the only line in the index containing `nat` is
`switchport trunk native vlan <id>`. The guard reads the dispatcher's *first words*, and this feature's first words
are `ip` and `show`, both already indexed, so every word behind them is outside what it can see. A reader on a box
holding the `nat` capability learns nothing about NAT from `help`; the pointer is the usage refusal behind the
feature's own word:

```
% Usage: show ip nat (rules | translations | statistics)
```

Recorded here rather than promised as indexed; the index is the code's to complete.

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
% spanning-tree portfast is not modelled: this device runs one spanning tree, and its only tunable is `spanning-tree priority <0-61440 in 4096 steps>`
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
FastEthernet0/1        unassigned      YES unset  down                  down
sw1(config)#do ping 10.0.0.1
% `do` runs a show command from config mode here: `do show <command>` (for anything else, leave config mode with `end`)
```

`test/command-answers-the-question.test.js` pins all three: 28 checks, 28 passed. It was 27 when #1494 landed and #2399 added the check on the words a box uses for a priority off the 4096 ladder, which is why the pre-fix tally adds up to 27: with the old handler, **11 passed / 16 failed**, each naming the neighbour's answer it used to give.

## A word the console does not know is never swallowed

Three handlers answering a neighbouring command's question (#1493) suggested a wider question: **what does each command family do when it is handed a word that does not exist?** Thirty-four cases, one nonsense word each, and every answer sorted into three classes:

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

`test/no-command-swallows-a-word.test.js` runs the whole sweep as a guard — 34 cases, three classes, and a rule for what an unquoted refusal is allowed to be — so the next command that accepts a word it does not know is caught by measurement rather than by someone noticing. 24 checks; it shipped with 21, of which the old handler passed 12 and failed 9.

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
| `ip name-server` | `% Invalid name server "": not an IPv4 address` | `% Incomplete command: ip name-server <address> [<address2> ... <address6>]` |
| `ipv6 address` | `% Invalid IPv6 address ""` | `% Incomplete command: ipv6 address <address>/<prefix> (or `ipv6 address autoconfig`)` |
| `vrrp 1 ip` | `% Invalid address: (none)` | `% Incomplete command: vrrp <vrid> ip <address>` |

A genuinely bad value is still quoted back (`Invalid name server "flurbish"`), so the two problems now read differently.

### `show` on its own called the command invalid

The same shape one level up, where the missing part is a *word* rather than a value. A bare `show`, and the two
view words that are only half a command, were all refused as words the console had never heard of:

```
sw1#show
% Invalid show command: (empty)
sw1#show mac
% Invalid show command: mac
sw1#show power
% Invalid show command: power
```

IOS separates the two faults: `% Invalid input detected at '^' marker.` is for a word the parser does not know at
that position, while `% Incomplete command.` means "You did not enter all the keywords or values required by this
command" (Command Reference, IOS XE 17.18.x, Catalyst 9200, "Using the Command-Line Interface", Table 3; the same
table in 15.2(7)E and 17.15.x). A 3750 transcript shows the same parser answering that way to a keyword chain one
word short — `SW1#clear mac address-table` -> `% Incomplete command.` The console also already knew both
completions: they are the two rows of `show ?` that print extra words.

```
sw1#show
% Incomplete command: name a view after `show` (type `show ?` for the list)
sw1#show mac
% Incomplete command: `show mac` is a view word with nothing after it - the box says `show mac address-table`
sw1#show pow
% Incomplete command: `show pow` is a view word with nothing after it - the box says `show power inline`
```

The spelling echoed back is the one typed, so `show m` is not answered as though `mac` had been typed. What did not
change: a word the console does not know is still `% Invalid show command: <word>`; an ambiguous prefix is still
ambiguous (`show po`); and the completed views print as before. The hint after the sentence is this console's habit
(`% Incomplete command: give a VLAN id (1-4094)`), not the box's — the vendor line stops at the full stop;
[`research/show-incomplete-view-word.md`](../research/show-incomplete-view-word.md) records that choice and the two
neighbouring questions left open (a shortened tail word, `addr`, and a tail typed in capitals, `Address-Table`).
`test/show-incomplete-view-word.test.js`: 23 checks; with the old handler, 9 passed / 14 failed.

## Two things measured and left alone

**Whitespace is already robust.** A lab is pasted, not typed, so the sweep's seven commands were also run with double spaces, a tab, a leading space, a trailing space, three trailing spaces and a mix: **42 variant runs, 0 differences** in either the answer or the resulting config. That property is pinned by a test rather than assumed.

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
% spanning-tree portfast is not modelled, so there is nothing to remove: this device runs one spanning tree, and its only tunable is `spanning-tree priority <0-61440 in 4096 steps>`
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

The table behind it is `NO_FORMS` in `engine/cli.js`: 33 branches — 16 in config mode, 9 at an interface, 8 in a
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
| `vrrp <vrid> priority` | 1-254 | 0, 1, 254, 255 |
| `spanning-tree priority` | 0-61440 in steps of 4096 | -1, 0, 61440, 61441 |
| `ipv6 nd ra lifetime` | 0-65535 | 0, 65535, 65536 |
| `ip ospf cost` | 1-65535 | 0, 1, 65535, 65536 |
| `ip ospf priority` | 0-255 | -1, 0, 255, 256 |
| `ping <address> <count>` | 1-50 | 0, 1, 50, 51 |

A refusal is also the place the range is quoted back, so both refusals must *state* it, and any value a refusal
offers as valid must itself be accepted. Two settings failed that (#1505); the rest of the table was already right
and stays as a guard.

### `channel-group 4097` built a bundle its own refusal says cannot exist

```
sw1(config-if)#channel-group 4097 mode active
Interface Fa0/2 added to channel group 4097 (mode active)                  ← before
% Invalid channel group id "4097": a channel group is identified by a number, 1-4096 (e.g. `channel-group 1 mode active`)   ← now
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
the range in the same words the neighbouring refusals use; a value that is merely off the ladder is answered with
the box's own allowed-values table, and every value in that table is one the check accepts (the regression walks
all sixteen).

Measured at the same time and correct as it stands: `encapsulation dot1q` and `ip access-group` refuse a *physical
port* and a *list that does not exist*, and both answer in terms of the real problem rather than the number.

## An all-numeric hostname is warned about, then taken - the vendor's own line

Every IOS and IOS XE `hostname` reference publishes the same rule — ARPANET host names: "They must
start with a letter, end with a letter or digit, and have as interior characters only letters, digits,
and hyphens" — and then states the outcome of one breach, with a transcript:

```
Device(config)#hostname 123
% Hostname contains one or more illegal characters.
123(config)#
```

"Creating an all numeric hostname is not recommended but the name will be accepted after an error is
returned." This console did neither half — it renamed in silence, so an operator got no word that the
name they had just typed is one a real box complains about:

```
Router(config)#hostname 123
Router(config)#                        <- before: no line, and the prompt still said Router
% Hostname contains one or more illegal characters.   <- now
123(config)#
```

The warning is not a refusal, and that distinction is the whole point: the name is stored, the prompt
carries it, `device.name` carries it, and `show running-config` prints `hostname 123`. Nothing after
the line is skipped. It is the vendor's sentence verbatim, full stop included, rather than this
console's `% Warning:` prefix, because recognising the line is the reason to print it.

**Only the numeric case is warned about, and that is deliberate.** The same reference prints the line for
`hostname \99` and then stops — it never shows the prompt that follows — and says nothing at all about
a leading digit, an underscore, a trailing dot or an interior space. Half the catalogue's own default
names are vendor model strings (`ZenWiFi ET8`, `FRITZ!Box 7590`) that breach the rule, so extending the
warning to the whole rule would put a line on every replayed running-config — a warning storm, which is
how a warning stops being read. Those shapes stay silent and stay open;
[research/hostname-illegal-characters.md](../research/hostname-illegal-characters.md) lists each one and
the capture that would settle it. The length ceiling is not one of them: it is a **refusal**, below.

## A name past 63 characters is refused — the ceiling is a rule, not a recommendation

Every IOS and IOS XE `hostname` reference states the ceiling as part of the command ("Names must be 63
characters or fewer"), and — unlike the character rules around it — a recorded session shows the outcome of
breaking it: the 63-character name taken, the 64-character name refused, the prompt still reading the old name.

```
sw1(config)#hostname aaaaaaaa…aaaaaaaa        <- 64 characters
% Hostname must have more than 1 character and must not exceed the maximum 63 character length.
  64 characters, so the name is still "sw1"
sw1(config)#
```

The first line is the box's, verbatim, `%` included — it names both bounds in one sentence, which is why it is
worth recognising on a console. The second is this console's: the count so the operator can trim without
counting by eye, and the name that survived, because a rename that failed in silence is the fault the
missing-argument refusal was written against (#1497).

The ceiling was absent, so `hostname <64 characters>` renamed the device everywhere — the config line,
`device.name`, the prompt, the canvas label — into a name no box will hold. It is asked **before** the
all-numeric warning, because a 64-digit name breaches both rules and a box answers the one that stops the
command rather than the one that merely comments on it.

**The lower half of that sentence is not modelled.** "must have more than 1 character" says a one-character
name is refused too, and no capture in hand shows it: the transcript's author tested 63 and 64. A one-character
name is still taken here. [research/hostname-length-limit.md](../research/hostname-length-limit.md) records
that gap, the CAT6500 report of a 12-character *prompt* field that is a different fact, and the printer
question the ceiling exposed (an unrenamed device prints its model-string name as the `hostname` line, which is
why four catalogue models needed a legal name seeded in `test/config-roundtrip.test.js`).

`test/hostname-length-limit.test.js` pins 25 checks: the 63-character name taken whole, 64 refused with both
lines and every piece of state unchanged, a 200-character name refused with its own count, a 64-digit name
answered by the length rule alone, spaces counted at the boundary in a multi-word name, and `no hostname`
still working after a refusal.

`test/hostname-illegal-characters.test.js` pins 45 checks: the exact line and the resulting
`123(config)#` prompt, the name reaching `show running-config`, the line printed once and before the
name is taken, a second identical rename warning again, the four other breach shapes staying silent as
written down, four catalogue-style names staying silent (the round-trip guard,
`test/config-roundtrip.test.js`, replays the 2,207 models that have an Ethernet port to seed a config
on and asserts no complaint), six legal names printing nothing, and `no hostname` restoring the
default without a warning.
