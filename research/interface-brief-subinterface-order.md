# `show ip interface brief`: where does a subinterface's row sit?

**Question (one, narrow).** In the one-line-per-interface table `show ip interface brief` prints on an
IOS-like router, is a subinterface listed **immediately under the physical interface it rides on** - before the
next socket - or after the physical interfaces, or somewhere else?

**Verdict: immediately under its parent.** Both `show ip interface brief` and `show interfaces` walk the port
list in interface order, and a subinterface is part of its parent's place in that walk. PacketForge's
`show interfaces` already printed it that way (the child block follows the parent block), but
`show ip interface brief` iterated the device's interface map and appended every subinterface after every
physical port, so a router-on-a-stick answered:

```
Interface              IP-Address      OK? Method Status                Protocol
GigabitEthernet0/0/0   unassigned      YES unset  up                    up
GigabitEthernet0/0/1   unassigned      YES unset  down                  down
GigabitEthernet0/0/2   unassigned      YES unset  down                  down
GigabitEthernet0/0/0.10 10.10.0.1      YES manual up                    up
GigabitEthernet0/0/0.20 10.20.0.1      YES manual up                    up
```

Two of five rows were one screen away from the port they describe, and the two views of the same list
disagreed about its order. No box prints that table.

## Evidence

| Source | Prints | What it settles |
| --- | --- | --- |
| [Cisco Community, "Cisco router 1921 problem", page 2](https://community.cisco.com/t5/other-network-architecture-subjects/cisco-router-1921-problem/td-p/4716312/page/2) - a live 1921 running 15.x, `sh ip int brie` pasted by the operator | `GigabitEthernet0/0/0 192.168.5.25 YES NVRAM up up` / `GigabitEthernet0/0/1 unassigned YES NVRAM up up` / `GigabitEthernet0/0/1.1 10.10.10.2 YES NVRAM up up` / `GigabitEthernet0/0/1.2 172.18.10.2 YES NVRAM up up` / `Gi0/0/1.600 10.20.10.2 YES NVRAM up up` / `GigabitEthernet0/0/2 unassigned YES NVRAM down down` | The decisive capture: three children of `0/0/1` sit **between** `0/0/1` and `0/0/2`, on a box whose `0/0/1` carries no address of its own. It also shows the table is walked in interface order, not "addressed interfaces first" - the parent row is `unassigned`. |
| [Cisco Community, "VIRL Routing Issue"](https://community.cisco.com/t5/routing/virl-routing-issue/td-p/4062129) - an IOSv router in VIRL, full `show ip int brief` | `GigabitEthernet0/0 10.255.0.150 ... administratively down down` / `GigabitEthernet0/1 unassigned YES manual up up` / `GigabitEthernet0/1.10 10.1.1.254 YES manual up up` / `GigabitEthernet0/2 unassigned YES manual up up` / `GigabitEthernet0/2.20 10.2.1.254 YES manual up up` / `Loopback0 192.168.0.1 YES TFTP up up` | Two different parents, each with its own child directly beneath it - the child belongs to *its* parent, not to the top of the table. The table is untruncated, so it also shows where the last physical port and the loopback fall. |
| [Cisco Community, "VDSL / Fiber Configuration"](https://community.cisco.com/t5/routers-small-business/vdsl-fiber-configuration/td-p/4393282) - a 2921, `show ip interface brief` in the thread | `GigabitEthernet0/0 10.158.211.5 YES DHCP up up` / `GigabitEthernet0/0.101 unassigned YES unset up up` / `GigabitEthernet0/1 unassigned YES manual administratively down down` / `GigabitEthernet0/1.101 unassigned YES unset deleted down` | The child stays under a parent that is **administratively down**, and even a child in the `deleted` state keeps its place. Position is a property of the interface, not of its state. |
| [Cisco Press, *Switching, Routing, and Wireless Essentials* ch. 4.4, Example 4-35](https://www.ciscopress.com/articles/article.asp?p=3089357&seqNum=7) | `show ip interface brief` on R1 with `G0/0/1.10`, `.20`, `.99` all `up up` (the sample's output is printed as an image in the web edition) | Corroborating teaching sample: one parent, three children, listed together. The three community pastes above are the readable evidence; this one is cited because this repository already relies on the same page for the parent/child **state** rule. |

Three independent boxes (1921, 2921, IOSv) with three different IOS versions agree, and no counter-example was
found: no capture shows a subinterface in a block of its own after the physical ports.

## What PacketForge printed, and what changed

The row loop in `engine/cli.js` walked `dev.interfaces.values()` and printed every child where the map put it -
after every physical port - while `show interfaces` re-ordered the same list parent-first. There were two
orderings of one list.

- `engine/cli.js`: a new module-level `orderWithChildren(list)` holds the parent-first walk that
  `show interfaces` had inline (parent, its children, next parent; a child recognised by its recorded `parent`
  or by the dotted name; an orphan printed last, never hidden). `show interfaces` now calls it instead of its
  own copy, and `show ip interface brief` runs its rows through it, so the two views cannot drift apart again.
  The header, the columns, the `Interface` spelling and the Port-channel rows appended at the end are unchanged.
- `test/interface-brief-subinterface-order.test.js` (9 checks): two children between parent and next port;
  each child under its own parent, not under the first one; a child staying under a shut parent (and reading
  the parent's `administratively down`/`down`); the two views printing one identical sequence; a switch with no
  subinterfaces still listing its ports in panel order.

Full suite after the change: **395 suites, 13,212 assertions, 0 failed**; `node scripts/syntax-check.js` clean.
With the `engine/cli.js` change reverted the new test fails 6 of its 9 checks, so it pins the behaviour rather
than the implementation.

## What is unresolved

* **Order between two *types* of port** (`Gi0/0` before `Fa0/1`, or the reverse). The box walks an interface
  index that is hardware-dependent; this model keeps the device's own list order. Same open half as
  `research/show-spanning-tree-port-order.md`.
* **Creation order vs numeric order among siblings.** All three captures created `.1`, `.2`, `.10` in numeric
  order, so they cannot separate "numeric" from "the order they were made". This model prints siblings in
  creation order, so a `.20` typed before a `.10` would print `.20` first. One capture with the two created out
  of order, followed by `show ip interface brief`, would settle it.
* **Where a Port-channel row goes.** A box places it by interface index; this console appends bundle rows after
  the interface list (pinned by `test/brief-port-channel-row.test.js`). No capture in hand shows a bundle row
  beside physical ports on a box that also has subinterfaces, so that position is left as it was.
* **Row order for SVIs** (`Vlan10`) relative to physical ports. The VIRL paste above shows a switch listing
  `Vlan10` after its physical ports; this model keeps the device's declaration order, which puts `Vlan1` where
  the catalogue declares it. Not asked here.
