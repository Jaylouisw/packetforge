# `show ip ospf interface <port>`: what a box says when OSPF is not on that port

**Question (one, narrow).** On a Cisco IOS/IOS XE box, when the port named in `show ip ospf interface <port>`
exists but OSPF is not running on it, what exactly does the command print - one message or a table, which words,
and does the answer name the reason (no address, port disabled, not in a `network` statement)?

**Verdict: one tagged system message, naming the port, with no reason.** `%OSPF: OSPF not enabled on
GigabitEthernet9/1` - the tag is glued to the percent sign, there is no `is`, the port is written in its long
type spelling with no space, and nothing follows it. Five captures agree, and they cover the three states this
console used to explain separately: an unaddressed physical interface, an L2 access port with no address, and a
port no `network` statement covers. PacketForge answered two of those with sentences of its own invention
(`% Gi0/1 has no address: OSPF needs one to form an adjacency`, `% Gi0/1 is not in OSPF`); both are gone.

## Evidence

| Source | Prints | What it settles |
| --- | --- | --- |
| [Cisco, "Initial Configurations for OSPF over Frame Relay Subinterfaces" (13693-22, PDF)](https://www.cisco.com/c/en/us/support/docs/ip/open-shortest-path-first-ospf/13693-22.pdf) | `R4-2503# show ip ospf interface s0` -> `%OSPF: OSPF not enabled on Serial0`, then `show ip ospf interface s0.1` on the same box -> the full block (`Serial0.1 is up, line protocol is up`, `Internet Address 1.1.1.2/24, Area 0`) | The line is about the *port*, not a missing process: the same box has a running OSPF process and prints a full block one subinterface away. The physical Serial0 carries no address (its address is on s0.1), so this is the **unaddressed** case. The capture also fixes the name (`s0` typed, `Serial0` printed). |
| [networklessons.com, "Troubleshooting OSPF Neighbor Adjacency"](https://networklessons.com/ospf/troubleshooting-ospf-neighbor-adjacency) | `R1#show ip ospf interface fastEthernet 0/0` -> `%OSPF: OSPF not enabled on FastEthernet0/0` | A second box, a second port type, the identical sentence; the page's own text says the interface is not covered by OSPF. |
| [networklessons.com, "Troubleshooting OSPF Route Advertisement(s)"](https://networklessons.com/ospf/troubleshooting-ospf-route-advertisement) | `R1#show ip ospf interface loopback 0` -> `%OSPF: OSPF not enabled on Loopback0` | A loopback - an interface type with no link state at all - draws the same line, so nothing in the message depends on the port being a physical wire. |
| [Cisco Community, "OSPF not enabled on GigabitEthernet" (td-p/2039094)](https://community.cisco.com/t5/switching/ospf-not-enabled-on-gigabitethernet/td-p/2039094) | `1#sh ip ospf interface gigabitEthernet 9/1` -> `%OSPF: OSPF not enabled on GigabitEthernet9/1`; the replies: "the device is just telling you this basic fact OSPF is not enabled on a L2 port" | The **L2 access port** case, and the typed/printed spelling pair (`gigabitEthernet 9/1` -> `GigabitEthernet9/1`). |
| [Cisco Community, "IP unnumbered ospf - SVI to subinterface" (td-p/3398254)](https://community.cisco.com/t5/other-network-architecture-subjects/ip-unnumbered-ospf-svi-to-subinterface/td-p/3398254) | `#sh ip ospf interface vlan 16` -> `%OSPF: OSPF not enabled on Vlan16`, while `gi 0/0/0.16` on the same paste prints the full block | An SVI, and a *fifth* independent box: same words, `Vlan16` for typed `vlan 16`. |

What the five agree on:

1. `%OSPF:` with **no space** after the percent sign, then one space, then `OSPF not enabled on ` and the port.
   It is a tagged message, not a sentence with a `% ` prefix like `% No interface ...`.
2. No `is`. Every capture reads `OSPF not enabled on X`, never `OSPF is not enabled on X`.
3. The port is the long type spelling with no space, whatever was typed (`s0` -> `Serial0`, `vlan 16` ->
   `Vlan16`, `gigabitEthernet 9/1` -> `GigabitEthernet9/1`).
4. Nothing after it: no table header, no hint about addresses or `no shutdown`, no `Total ...` line.
5. The reason is not in the message. An unaddressed Serial0, a switchport with no address, an unnumbered SVI and
   a loopback outside every `network` statement all produce the identical line.

## What is known, inferred, unresolved

**Known.** The words, the punctuation, the name expansion and the one-line shape, from five captures across four
platform classes (ISR-style router with Frame Relay, 12.2-era router, L3 switch, IOS XE SVI). The line is
independent of whether a process exists on the box: 13693-22 prints it beside a working adjacency on s0.1.

**Inferred.** That the message is the same on a Catalyst running 15.x/17.x: the closest capture is the
Community L3-switch paste (2039094), which is IOS but carries no version banner.

**Unresolved (and therefore untouched in the engine).**

* **A port that is administratively disabled.** No capture was found for `show ip ospf interface <port>` naming
  a port in that state. Two shapes are plausible - the same `%OSPF:` line, or the head of the interface block
  (`GigabitEthernet0/1 is administratively down, line protocol is down`) - and this console prints
  neither: it keeps its own `% Gi0/1 is administratively down: OSPF runs on ...`. That sentence is a claim no box
  makes, but guessing between two vendor shapes on no evidence would be worse.
* **A port the box does not have.** `% No interface Gi9/9 on <box>` is this console's sentence for every view.
  What IOS prints for `show ip ospf interface gi9/9` (a `%OSPF:`-tagged refusal, a bare `% Invalid input`, or
  nothing) was not found.
* **A box with no OSPF process at all.** `show ip ospf interface <port>` on a router with no `router ospf`
  keeps this console's `% OSPF is not enabled (use "ospf router-id <ip>" in config mode)`. The closest evidence
  is Cisco's IOS 12.2SR guide, which documents a different message for a process that exists without a
  router-id - "If the process is not active and the show ip ospf command is entered, the message
  `%OSPF: Router process X is not running, please provide a router-id` will be displayed"
  ([IP Routing: OSPF Configuration Guide, 12.2SR](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/iproute_ospf/configuration/12-2sr/iro-12-2sr-book/iro-imode-ospfv2.html)) -
  and that one is about `show ip ospf`, not about the per-port view. Whether the per-port view prints the same
  `%OSPF: OSPF not enabled on ...` line with no process at all is the obvious next question, and it is not
  answered here.
* **The table's own name column.** `show ip ospf interface` (no port) still prints this console's own table
  with the short name (`Gi0/0/0`) in its `Interface` column, while the message beside it now uses the long form.
  Whether a real table row reads `GigabitEthernet0/0/0` - it does in every Cisco sample of the *full block*
  form - is a question about this console's table, not about this message, and is left alone.

## What would settle the rest

One paste from any IOS 15.x/17.x box with two ports, one disabled and one fine:

```
show ip ospf interface <the disabled port>
show ip ospf interface <a port no network statement covers>
show ip ospf interface <a name that does not exist>
no router ospf 1
show ip ospf interface <any addressed port>
```

Five commands, five answers, and each of the four open items above closes or is refuted by one of them.

## What changed

* `engine/cli.js`, `_showOspf`, the per-port branch of `show ip ospf interface`: the two invented sentences
  (`... has no address: OSPF needs one to form an adjacency` and `... is not in OSPF`) are replaced by
  `%OSPF: OSPF not enabled on <long name>`, with the name expanded by `iface-name.displayName()` - the same
  table `show ip interface brief` already uses, so a port cannot be named two ways by two views of one box. The
  disabled-port and no-such-port branches are unchanged and say so in comments.
* `test/show-ospf-interface-not-enabled.test.js` (12 checks): the exact line, the one-line shape, the glued tag,
  the absence of both old sentences, three spellings of the same port resolving to the printed long name, an L3
  switch's port drawing the same line, the disabled-port and unknown-port branches staying as they are, and the
  table itself not gaining a system message.
* `test/show-ospf.test.js`: one assertion that expected the reason to be named now expects the vendor line.
* `docs/CLI.md`: the snippet under "Reading `show ip ospf`" shows the box's line and states what it does not say.
