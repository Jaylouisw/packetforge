# The Vlan1 nobody configured: does a factory switch have a management SVI, and how does each view print it?

**Question (one, narrow).** On an IOS-like switch with an empty configuration, does an interface for
VLAN 1 exist before anybody types anything? If it does, what do `show running-config`,
`show ip interface brief` and `show interfaces` print for it - and what has to be true before it reads
`up`?

**Verdict: the interface exists on every Catalyst, and PacketForge has no SVI at all - but only half the
question can be answered from the captures in hand, so nothing was coded.** The structural half is
consistent: a Catalyst carries an `interface Vlan1` stanza in its configuration before it is configured,
and `show ip interface brief` lists it. PacketForge refuses `interface vlan 1` as a name it does not know
and prints no `Vlan1` row, so a capture and this console cannot be compared line for line. The cells of
that row are **not** consistent across the captures: `administratively down down` on the Catalyst 9200/9300
command references, `down down` on a 6500 capture, `unset` versus `NVRAM` for the same column on two
releases. And the fix is not a wording change: it is an interface object with autostate, which is a
feature, and this run is not allowed to add one.

## What PacketForge does today

Measured on `a9e74b2e` + this branch, on the 8-port `generic-switch`, with nothing configured:

```
sw1#show ip interface brief
Interface              IP-Address      OK? Method Status                Protocol
FastEthernet0/1        unassigned      YES unset  down                  down
...                    (eight physical ports, no Vlan1 row)

sw1(config)#interface vlan 1
% Interface not found: vlan 1
sw1(config)#interface VLAN1
% Interface not found: VLAN1

sw1#show interfaces vlan 1
% No interface vlan 1 on Switch (L2)-sw1
sw1#show ip interface vlan 1
% Invalid show command: ip interface vlan 1
```

`show running-config` contains no `interface Vlan1` block; `show vlan brief` *does* print the VLAN 1 row,
with every access port in it - the VLAN database knows about VLAN 1 even though no interface represents
it. A switch can only be given a management address on a physical port here, which is the same compromise
recorded in `research/ip-address-on-l2-port.md`.

## What is known

| # | Source | Says |
|---|--------|------|
| 1 | [Catalyst 9300 Command Reference, IOS XE 16.12, `show running-config` / `show tech-support` sample](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9300/software/release/16-12/command_reference/b_1612_9300_cr/system_management_commands.html) | A real 9300 configuration contains, between the physical interfaces and `ip forward-protocol nd`: `interface Vlan1`, then `no ip address`, then the shutdown line, then `!`. The stanza is present in a config nobody configured VLAN 1 in. |
| 2 | [Catalyst 6500 SIP/SSC/SPA Configuration Guide, "Troubleshooting the ATM SPAs"](http://cisco.com/c/en/us/td/docs/interfaces_modules/shared_port_adapters/configuration/6500series/sipspasw/76tblatm.html) | `show ip interface brief` sample, first row: `Vlan1   unassigned   YES NVRAM   down   down` - the interface is listed, and the Status word is `down`, **not** `administratively down`. |
| 3 | [Catalyst 9200 Command Reference, IOS XE 17.7](http://cisco.com/c/en/us/td/docs/switches/lan/catalyst9200/software/release/17-7/command_reference/b_177_9200_cr/interface_and_hardware_commands.html); same example in [16.10](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9200/software/release/16-10/command_reference/b_1610_9200_cr.pdf), [17.12](http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9200/software/release/17-12/command_reference/b_1712_9200_cr/interface_and_hardware_commands.html), [17.13](https://cisco.com/c/en/us/td/docs/switches/lan/catalyst9200/software/release/17-13/command_reference/b_1713_9200_cr/interface_and_hardware_commands.pdf) and [26.x](http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9200/software/release/26-x/command_reference/b_26x_9200_cr/interface_and_hardware_commands.html) | Same view, same first row, different words: `Vlan1 unassigned YES NVRAM administratively down down`. The same page's `show ip interface Vlan1` example opens `Vlan1 is up, line protocol is up`. In this sample the physical ports split between `NVRAM` (GigabitEthernet0/0, 1/0/1) and `unset` (1/0/2 onwards). |
| 4 | [Cisco Community thread "% IP addresses may not be configured on L2 links", print view](https://community.cisco.com/t5/forums/forumtopicprintpage/board-id/5991-discussions-wan-routing-switching/message-id/399458/print-single-message/false/page/1) | A 1905 ISR with a 4-port EHWIC switch card pastes its own `show ip interface brief`; last row: `Vlan1 unassigned YES unset down down`. A third combination of Method and Status - and on a router, which shows the SVI is a property of the switch feature rather than of the box being a Catalyst. |
| 5 | [Community tech-support paste (`router_a.txt`)](https://community.cisco.com/kxiwq67737/attachments/kxiwq67737/6016-discussions-lan-switching-routing/540899/1/router_a.txt) | `interface Vlan1` in the config, and `Vlan1 is administratively down, line protocol is down , Autostate Enabled` / `Hardware is Ethernet SVI` from `show interfaces`. Also `Vlan305 is up, line protocol is up , Autostate Enabled`. |
| 6 | [Catalyst 2960-X Configuration Guide 15.2(2)E, "Configuring Interface Characteristics"](http://cisco.com/c/en/us/td/docs/switches/lan/catalyst2960x/software/15-2_2_e/consolidated_guide/configuration_guide/b_1522e_consolidated_2960x_cg/m_int_inter_cg.pdf) | The autostate rule, as three conditions: the SVI's line state is up when "the VLAN exists and is active in the VLAN database", "the VLAN interface exists and is not administratively down", and "at least one Layer 2 (access or trunk) port exists, has a link in the *up* state on this VLAN, and is in the spanning-tree forwarding state on the VLAN". |
| 7 | [Catalyst 2960 Configuration Guide 12.2(58)SE, "Assigning the Switch IP Address"](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960/software/release/12-2_58_se/configuration/guide/2960scg/swipaddr.html) | The documented way to address a switch: `interface vlan <vlan-id>` (range 1-4094), `ip address`, then the verify step `show interfaces vlan <vlan-id>`. A saved-config sample in the same chapter prints the stanza as `interface VLAN1`. |
| 8 | [Catalyst 9300 Interface and Hardware Commands, IOS XE 17.12 (PDF)](http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9300/software/release/17-12/command_reference/b_1712_9300_cr/interface_and_hardware_commands.pdf) | `show interfaces` sample line: `Vlan1 is administratively down, line protocol is down , Autostate Enabled` - the trailing clause names the mechanism in source 6. |

## What is inferred

* The factory stanza is shut (source 1), which is why the 9200-family captures say
  `administratively down` while the 6500 capture says plainly `down`: that box's Vlan1 was most likely
  brought up with `no shutdown` and had no member port up, which is exactly the third autostate condition.
  Neither capture shows the commands that produced it, so this is inference, not a reading.
* `Method` is a property of where the config lives on that platform, not of the interface's state: on one
  9200 sample, unassigned physical ports print both `NVRAM` and `unset`, and Vlan1 prints `NVRAM`.
  PacketForge's `unset` for an unassigned port (pinned by `test/ip-interface-brief.test.js`) is therefore
  right for at least one box and wrong for another, on the same release.
* The name is stored as `Vlan1` by the CLI (`show interfaces Vlan1` in the 9200 sample) and can be read
  back as `VLAN1` in a saved config (source 7) - the same case-insensitive spelling rule this console
  already applies to port names.

## What is unresolved

1. **Which word a factory 2960 prints for Vlan1's Status** - `down` (6500; the 1905 ISR paste) or
   `administratively down` (9200/9300). No capture in hand states the box's configuration at the moment of
   the capture, so the two cannot be separated into "state" and "platform".
2. **The Method cell on a 2960** - `unset`, `NVRAM` and `TFTP` all appear in captures from different
   platforms; nothing found ties the word to a model.
3. **What `no shutdown` alone does** to the brief row when no port is in VLAN 1: `down/down` by autostate,
   but no transcript shows the row before and after that one command.
4. **Whether `show interfaces vlan 1` is accepted** as the 2960 guide's verify step alongside
   `show interfaces Vlan1`; and whether `show ip interface Vlan1` (used by the 9200 example) is a form the
   console owes. PacketForge answers `% Invalid show command: ip interface vlan 1` today.
5. **Whether a switch with no `interface Vlan1` line is possible** - e.g. a platform whose default config
   omits it. No such capture was found; source 1 is one 9300.

## What would settle it

A transcript from a factory-default Catalyst 9300 (17.x) and 2960X (15.2), in this order, with no other
commands in between:

```
show running-config interface Vlan1
show ip interface brief
show interfaces Vlan1
configure terminal / interface vlan 1 / no shutdown / end
show ip interface brief
show interfaces Vlan1
```

then the same three views after putting exactly one access port up in VLAN 1. The first three answers
decide the default words; the last three decide the autostate transition.

## Why nothing was changed

Two reasons, either sufficient:

* **It is a feature, not a wording fix.** A `Vlan1` row cannot be printed honestly without an interface
  object that holds an address, participates in forwarding, and computes its line state from VLAN
  membership and STP (source 6). This console's switches have no SVI; `interface vlan 1` is refused as an
  unknown *name*, and adding the object is new capability.
* **The cells disagree.** Adopting `administratively down down` would contradict source 2 and source 4;
  adopting `down down` would contradict five releases of the 9200 reference. Guessing one would make the
  console confidently wrong on half the boxes it imitates.

`test/ip-interface-brief.test.js` keeps pinning what the console does print - the physical rows and their
`unset` Method - so a future SVI implementation has a baseline to extend rather than a surprise.
