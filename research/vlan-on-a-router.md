# `show vlan` on a router: does a routed port belong to a VLAN, and does the box answer at all?

**Question (one, narrow).** On a Cisco IOS router, is a routed port a member of a VLAN - does it appear in the
Ports column of the VLAN table - and can the box be asked that question at all?

**Verdict, split in two.**

1. **A routed port is in no VLAN. Settled, and adopted here.** A routed port has no access VLAN, no trunk
   encapsulation and no switchport configuration; `show interfaces switchport` refuses it with "is not a
   switchable port". On a router *with* a switch module the VLAN table lists the module's ports only. The
   console nevertheless walked every interface on every device, so a router's own `show vlan` printed:

   ```
   VLAN Name                             Status    Ports
   ---- -------------------------------- --------- -------------------------------
   1    default                          active    Gi0/0, Gi0/1, Gi0/2
   ```

   - three routed sockets offered as members of VLAN 1, which the hardware cannot produce. Fixed: a device that
   does not bridge has no members (and no reserved rows either, which was already the rule).
2. **Whether a router answers `show vlan` at all is platform-dependent. Unresolved as a single rule.** The
   sparse evidence below ranges from "invalid input" to "a database of two VLANs" to a documented `vlan` and
   `switchport access vlan` on routers with switch ports. The model keeps answering with the table (a decision
   `test/show-vlan-reserved-defaults.test.js` already pins), because the catalogue cannot say which devices have
   a switch module - and an invented refusal would be as wrong as an invented table.

## Evidence

| Source | Says |
| --- | --- |
| [Cisco, "EtherSwitch Network Module" (IOS LAN switching configuration guide)](https://www.cisco.com/en/US/docs/ios/lanswitch/configuration/guide/lsw_enet_switch_net.html) | `Router# show vlan-switch brief` -> `1 default active Fa0/2, Fa0/9, Fa0/14, Gi0/0`. The table exists on a router, is asked for by a **different command name**, and lists the switch module's ports. |
| [Cisco, Layer 2/3 Switching Software Configuration Guide for the 1000 Series Connected Grid Routers](https://www.cisco.com/c/en/us/td/docs/routers/connectedgrid/cgr1000/ios/software/15_4_1_cg/FEvlan_switchconf.html) | The same table, same wording, same column widths, on a router platform: `1 default active Fa0/2, Fa0/9, Fa0/14, Gi0/0`, `5 VLAN0005 active` (a VLAN with no ports prints an empty cell). |
| [Cisco IOS LAN Switching Command Reference, `show vlan-switch`](https://www.cisco.com/c/en/us/td/docs/ios/lanswitch/command/reference/lsw_book/lsw_s2.html) | `show vlan-switch` is documented **for routers** - "To display VLAN information, use the `show vlan-switch` command", ids 1-1005. The switch command is `show vlan`; the router spelling is the one with `-switch` in it. |
| [Cisco Learning Network, "Assigning Ports to Vlan" (GNS3 EtherSwitch router)](https://learningnetwork.cisco.com/s/question/0D53i00000KswXbCAJ/assigning-ports-to-vlan) | `ESW1# show int fa0/0 switchport` -> `% Fa0/0 is not a switchable port`. Ports in slot 0 are routed; only the module's Fa1/x are switchports. `show vlan-switch` lists the module ports. Also `%Access VLAN 12 does not exist.` / `Please add it to vlan database` - a **different** wording from the switch's "Creating vlan 12". |
| [Cisco Community, "Cisco 837 ethernet / fastethernet config"](https://community.cisco.com/t5/routing/cisco-837-ethernet-fastethernet-config/td-p/706185) | `Router#vlan database`, `Router#show vlan`, `Router(config)#vlan 10` and `Router(config)#int vlan 10` all -> `% Invalid input detected at '^' marker.` On this box there is no VLAN database at all. |
| [Cisco Community, "Cannot create vlan on 2811"](https://community.cisco.com/t5/switching/cannot-create-vlan-on-2811/td-p/2106778) | `Router(config)#vlan database` and `Router(config)#vlan 35` both -> `% Invalid input detected at '^' marker.` in **global config mode**; the working path is privileged `vlan database` ... `apply`, then `sh vlan-sw br`. |
| [Cisco Community, "Cisco 877 and Vlans"](https://community.cisco.com/t5/switching/cisco-877-and-vlans/td-p/3339045) | The same kind of box **does** hold a database, with a ceiling: `Pixel_R1(config)#vlan 30` -> `Vlan can not be added. Maximum number of 2 vlan(s) in the database.` So "a router has no VLANs" is false as a general rule, and so is "it has 4094". |
| [Cisco, "Configure Ethernet Switch Ports" (ISR 1000 Series)](https://www.cisco.com/c/en/us/td/docs/routers/access/isr1100/software/configuration/guide/isr1100-sw-config/configuring_ethernet_switchports.html) | A current router platform takes `vlan 2` in **global config**, then `interface vlan 2`, then `switchport access vlan 2` on `gigabitethernet 0/1/0` - the switch grammar, on a router. |

## What is known

1. A routed port belongs to no VLAN, on any platform. The router's VLAN table (where it has one) names switch
   module ports and nothing else. That is the rule this increment adopts.
2. The *name of the command* differs by platform: switches take `show vlan`; routers with a switch module take
   `show vlan-switch`. A router with no switching hardware takes neither.
3. A router's VLAN database, when it exists, is reached by privileged `vlan database` ... `apply` on classic IOS
   (`vlan` in global config is invalid there), and by plain `vlan <id>` in global config on current platforms
   with integrated switch ports. The two grammars are not interchangeable.
4. On the module platforms the "VLAN does not exist" wording is different too: `%Access VLAN 12 does not exist.`
   / `Please add it to vlan database`, not the switch's `% Access VLAN does not exist. Creating vlan 12`. This
   model implements the switch wording only, and only where a VLAN database exists.

## What is inferred

* **The empty cell, not a dropped row.** The Connected Grid sample prints `5 VLAN0005 active` with nothing under
  Ports, so an empty Ports cell is something the device prints. That is the shape this model now uses for a
  non-bridging box: the row is the VLAN's, the cell names no member because the box has none.
* **`isL2()` is the right predicate.** `Device.inactiveVlan()` already refuses to answer for a device that does
  not bridge; membership in a VLAN table is the same question asked from the other side, so it uses the same
  test rather than a second one that could drift.

## What is unresolved

* **Whether a plain router should answer `show vlan` with a table at all.** The 837 says no (invalid input), the
  2811 needs `vlan database`, the ISR 1100 says the global `vlan` command is normal. Nothing found states the
  rule per platform, and the catalogue has no "has a switch module" flag to hang it on.
* **`show vlan` vs `show vlan-switch` on the same module-equipped box.** Only the `-switch` spelling appears in
  the router documents; whether `show vlan` is an alias there, or invalid input, was not found.
* **Which VLANs a module router counts as reserved.** The Learning Network transcript shows `1002 ... active`,
  not `act/unsup`, on a router's module - a difference from the switch table this model prints (and it prints no
  reserved rows on a non-bridge at all).

## What was changed

* `engine/cli.js`, `show vlan`: membership is collected only when `dev.isL2()` - the same predicate
  `Device.inactiveVlan()` uses. A non-bridging box keeps its rows and its empty Ports cells; a switch is
  untouched.
* `test/show-vlan-router-ports.test.js`, 15 assertions: the router's VLAN 1 and a hand-made VLAN 10 both print
  empty Ports cells; the router still answers (the earlier decision is preserved); the predicate is the shared
  one; a switch still lists all eight access ports across the wrapped cell; moving a port to VLAN 20 moves it out
  of VLAN 1; the four reserved rows still print on a switch and have no Ports cell.

## What evidence would settle the rest

1. One `show vlan` and one `show vlan-switch` from the same module-equipped router (2811 + HWIC-4ESW, or a CGR
   1000) - two commands, one paste, and the alias question is answered.
2. One `show vlan` from a router with **no** switch module on a current image (ISR 4331, IOS XE 17) - does it
   print invalid input, or an empty table?
3. A vendor table of which router families support `vlan` in global config, which need `vlan database`, and
   which have neither. That is the flag the catalogue would need before the command itself could be refused per
   platform instead of answered for all.
