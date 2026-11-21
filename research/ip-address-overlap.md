# One subnet, one wire: which `ip address` collisions a box refuses

**Question (one, narrow).** A router holds one connected route per subnet, so two of its ports cannot hold
addresses in the same subnet. What exactly does IOS refuse, what does it print, what does it leave behind —
and which part of that can this model reproduce without inventing the rest?

**Verdict: known, and adopted — including which moment the check happens at and how the port is spelled.**
A second primary address in a subnet another port on the same box already holds is refused with one line —
`% <attempted network> overlaps with <port>` — and nothing is applied. `<port>` is the interface's full type
spelling, whatever the operator typed to select it. The line was printing the catalogue's panel spelling
(`Gi0/0`), which contradicts every capture in hand; it now goes through `displayName()`, the expansion
`show ip interface brief` and the `show arp` Interface column already use. The rule belongs to the routing table rather than to the
typing, so it is also asked when a port is opened: a port that is administratively down takes an overlapping
address in silence, and `no shutdown` is where the collision surfaces. The earlier version of this note
listed that as unresolved on one contributor's sentence; a second, worked source and an IOS SVI log now
agree with it, and the model follows them. What is still open is narrower and listed at the end.

## The evidence

Public transcripts, from different people, print the same sentence with the same shape:

| Typed (the operator's own lines) | Incumbent | Printed |
|---|---|---|
| `ip address 192.168.254.32 255.255.255.192` | `192.168.254.1 255.255.255.192` on `FastEthernet0/0` | `% 192.168.254.0 overlaps with FastEthernet0/0` |
| `int g0/1` then `ip add 10.1.1.2 255.255.0.0` | `10.1.1.1 255.255.0.0` on `GigabitEthernet0/0` | `% 10.1.0.0 overlaps with GigabitEthernet0/0` |
| `ip address … 255.255.255.128` on `GigabitEthernet0/1.10` | `192.168.1.x` on `GigabitEthernet0/1` | `% 192.168.1.0 overlaps with GigabitEthernet0/1.10` |
| `int eth0/1` then `ip add 10.10.12.2 255.255.255.0` | `10.10.12.x` on `Ethernet0/0` | `% 10.10.12.0 overlaps with Ethernet0/0` |
| `interface fa1/0` then `ip address 192.168.2.1 255.255.248.0` | `192.168.1.1 255.255.248.0` on `Fa0/0` | `% 192.168.0.0 overlaps with FastEthernet0/0` |
| `ip address 172.20.101.1 255.255.255.0` (a second port) | `172.20.100.1 255.255.254.0` on `Gi0/1` | `% 172.20.101.0 overlaps with GigabitEthernet0/1` |

* https://learningnetwork.cisco.com/s/question/0D53i00000Kt12sCAB/can-one-subnet-be-on-opposite-sides-of-a-router
* https://learningnetwork.cisco.com/s/question/0D53i00000Ksv3lCAB/two-interfaces-on-the-same-subnet
* https://learningnetwork.cisco.com/s/question/0D53i00000KsxMfCAJ/subinterfaces
* https://community.cisco.com/kxiwq67737/attachments/kxiwq67737/4461-docs-network-infrastructure/4344/1/82006-VRF-Lite.pdf
  (a Cisco Community VRF-Lite deck: `R1(config)#int eth0/1`, then `% 10.10.12.0 overlaps with Ethernet0/0`)
* https://serverfault.com/questions/510266/cisco-router-configuration-subnet (the question works on `Fa0/0` and
  `fa1/0` and is answered with `FastEthernet0/0`)
* https://www.connecteddots.online/resources/cisco/network-overlaps-with-GigabitEthernet (works on `Gi0/0`/`Gi0/1`,
  prints `GigabitEthernet0/1`)
* https://community.cisco.com/t5/switching/overlaps-with-gigabitethernet-1-router-2-core-switch/td-p/4531370
  (`10.1.10.0 overlaps with GigabitEthernet0/0/0.10`)

Four things are established by those transcripts rather than inferred from them:

1. **The number is the attempted network, under the attempted mask.** `10.1.1.2 255.255.0.0` prints
   `10.1.0.0`, not `10.1.1.0`; `192.168.254.32 255.255.255.192` prints `192.168.254.0`. Both are the network
   of the address being typed under the mask being typed.
2. **The port that got there first is named**, in the box's full type spelling — `FastEthernet0/0`,
   `GigabitEthernet0/0`, `Ethernet0/0`, `GigabitEthernet0/0/0.10` — whatever the operator typed. Two of the
   transcripts show the rule operating on a shortened typed name (`int g0/1` → `GigabitEthernet0/0`,
   `int eth0/1` → `Ethernet0/0`), so the cell is the interface's canonical name, not an echo of the line that
   selected the port. A subinterface keeps its suffix attached to the parent's long name.
3. **Nothing is applied.** The first transcript runs `show ip int bri` after the refusal: the second port is
   still `unassigned`, the first is unchanged.
4. **A subinterface collides like a port.** The third transcript is a `Gi0/1.10` subinterface against its own
   parent, so the rule is about the routing table, not about physical ports.

The reason the box refuses is stated plainly by the same sources and by Cisco's own teaching material: the
connected route for the subnet would have two next hops, so routing could not say which wire to send by.

### The one sentence that disagrees

A Cisco Learning Network thread quotes the error as `"192.168.7.32 overlaps with Gi0/0"`
(https://learningnetwork.cisco.com/s/question/0D53i00000Ksn7BCAR/overlapping-ips). It is the only place a
short spelling is attributed to the box, and it is a paraphrase: the sentence has no `%`, and the same post
writes `Gi0/0`/`Gi0/1` in its own prose throughout, which is how an operator retells an error rather than
pastes one. Against it stand two transcripts where the *typed* name is short and the *printed* name is long
(`int g0/1` → `GigabitEthernet0/0`, `int eth0/1` → `Ethernet0/0`) — if the box echoed the typed name, those
would read `GigabitEthernet0/0` only by coincidence, twice. The rule adopted is the long spelling; the
dissenting sentence is recorded here rather than silently dropped.

A second divergence worth naming, because it would matter if a capture ever needs to be matched verbatim: a
Network Engineering Stack Exchange question retypes the line as `192.168.1.0 overlaps with Ethernet 0/0.10`
(https://networkengineering.stackexchange.com/questions/74495/), with a space between the type and the number
and no `%`. That spacing appears in no machine capture and is left unmodelled; the name this console prints
comes from the catalogue, which has no space.

## When the check runs: at address entry, or at link-up

The three transcripts above are all on ports that are up, so they only show one half of the rule. A worked
example that walks both halves is Connected Dots' page on this exact error - the same site this repo already
cites for `Bad mask`:

* https://www.connecteddots.online/resources/cisco/network-overlaps-with-GigabitEthernet

It runs the same collision three ways on one router, `Gi0/1` holding `172.20.100.1 255.255.254.0`:

| State of the port being configured | Typed | Printed |
|---|---|---|
| `Gi0/0` up | `ip address 172.20.101.1 255.255.255.0` | `% 172.20.101.0 overlaps with GigabitEthernet0/1` |
| `Gi0/0` shut | the same line | nothing — the address is accepted |
| `Gi0/0` shut, address held, then `no shutdown` | — | `% 172.20.101.0 overlaps with GigabitEthernet0/1`, and the port stays administratively down |

Its explanation is the one the routing-table reading predicts: while the port is shut it "will not be
involved in any routing decisions", so there is no connected route to collide with; opening it is what tries
to install one. The page then closes the loop — shutting `Gi0/1` first makes the same `no shutdown` succeed.

A second, independent report shows the same moment on a switch, in IOS's own log wording: an SVI whose
address overlaps another SVI is kept down by the box, and the log says so —

> Failed to configure IP address on Vlan123. IP address overlaps with one of the address configured on
> Vlan321 in vrf default. Vlan123 has been shutdown. Please change the IP address to avoid overlap and
> perform a "no shutdown".

* https://community.cisco.com/t5/switching/vlan-interface-administratively-down/td-p/745649

That is a different sentence from the CLI's one line (an SVI-specific log record, not a `%` refusal), so it is
evidence for *when* the rule fires, not for what this console should print. The CLI line stays the one the
transcripts above print.

## What this model now does

`_ipOverlapRefusal()` in `engine/cli.js` runs on `ip address <address> <mask>` before anything is stored:

* compares the **ranges**, not the prefixes - `start <= otherEnd && otherStart <= end` - so `10.1.1.1/16`
  and `10.1.2.1/24` collide in either order, which "same subnet" would miss;
* compares against every other interface on the same device that holds a static address, subinterfaces
  included, and names the first one it finds in hardware order;
* prints `% <network> overlaps with <port>` and returns before the port is touched, so `iface.ip`, `iface.mask`
  and the DHCP flag keep their previous values and `show running-config` never carries the refused line;
* spells `<port>` through `displayName()` (`engine/iface-name.js`), the same expansion `show ip interface brief`
  and the `show arp` Interface column use, so a Catalyst's stored `Gi1/0/1` prints as `GigabitEthernet1/0/1` and
  a subinterface as `GigabitEthernet0/0/0.10`. Before this the line carried the catalogue's panel spelling
  (`% 192.168.254.0 overlaps with Gi0/0`), which no capture shows and which cannot be diffed against one.

The same function answers the admin-state question through `_portReservesSubnet()`: a port counts as holding
a subnet only when it is not administratively down, and a subinterface counts only when its parent is not. So

* `ip address` on a closed port takes an overlapping address in silence - it returns before the comparison,
  which is what the Connected Dots transcript shows;
* the command that opens such a port asks the same question first, and a collision is answered with the same
  one line, with `enabled` left `false` - the port stays administratively down, as the transcript has it.
  Nothing else is printed: the box does not also claim the port came up;
* a closed incumbent no longer blocks a live port, and a closed port whose address overlaps a live one keeps
  its subnet out of `show ip route` while it is down, which is the fact the whole rule is about.

`test/ip-address-overlap.test.js` - 22 checks: the exact line (long spelling, suffix intact), the unchanged port in
`show ip interface brief` and in `show running-config`, the two containment directions, adjacent /25s
allowed, a port re-addressed on itself, the subnet freed by `no ip address`, a second device in the same
subnet, a subinterface against its parent, and the four admin-state cases above (a closed port accepts, the
opening command refuses and leaves the port closed, closing the incumbent lets it open, a closed parent frees
its subinterface's subnet).

## What remains unresolved

* **An incumbent whose line protocol is down but which is not administratively down.** Every source in hand
  speaks of the *administrative* state - "administratively shutdown", "shutdown", `interface Gi0/1` then
  `shutdown`. What a box does when the incumbent has no carrier, or when the cable is in but the far end is
  down, is not witnessed. The model reads `enabled` only (plus the parent's, for a subinterface), so an
  unplugged but un-closed port still reserves its subnet. A connected route really does leave the table when
  line protocol drops, so the alternative is plausible - but plausible is not evidence, and it would make a
  lab's answer depend on whether a cable was drawn.
  *What would settle it:* `ip address` on a live port while another, open but unconnected, port holds an
  overlapping address.
* **An address a DHCP client holds at run time.** The check happens while the address is typed, and a lease
  does not exist yet, so a static address that lands on a leased subnet after a run is not caught here. A real
  box would not know either at configure time; whether it refuses later, when the lease arrives, is a question
  about the DHCP client's behaviour, not about this rule.
* **Secondary addresses.** IOS lets one interface carry several subnets with `ip address ... secondary`, and a
  secondary address may legitimately sit beside another interface's subnet in some designs. This model has no
  `secondary` keyword, so the rule needs no exception for one - and the day it does, the exception belongs
  with the keyword, not here.
* **VRFs.** Overlapping subnets across VRFs are explicitly allowed by IOS (Cisco's VRF guides say so at
  length), and this model has no VRF, so nothing here can collide across one.
* **The SVI log wording.** The switch log in the second source is not the CLI's one line, and this console
  models no log stream at all; if one is ever added, that sentence is the evidence for it, not this note's.
