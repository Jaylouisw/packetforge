# The order of the `switchport` lines in a `show running-config` interface block

**Question (one, narrow).** In what order does a real IOS-like switch print the `switchport` sub-commands
inside one interface block of `show running-config` - the VLAN parameters first, or `switchport mode` first, and
where does `switchport voice vlan` sit?

**Verdict: the parameters come first and `switchport mode` follows them; the voice line comes last.** Two
Cisco-published `show running-config` samples show it directly. The engine printed the mode first, and now
prints the vendor's order. One placement - `switchport trunk allowed vlan` - is inferred rather than observed,
and one source contradicts the access/native relative order; both are recorded below.

## Evidence (observed output, not command reference text)

| Source | Shows |
| --- | --- |
| [Cisco IOS Software Configuration Guide, Release 12.2(33)SXH and later, "Configuring Smart Port Macros", p. 3-9](https://www.cisco.com/en/US/docs/general/Test/dwerblo/broken_guide/smrtport.pdf) | `Router# show running-config interface gigabitethernet 2/2` after the `cisco-phone` macro: `interface GigabitEthernet2/2` / `switchport access vlan 2` / `switchport mode access` / `switchport voice vlan 3` / `switchport port-security` / `switchport port-security maximum 3` / ... |
| Same guide, p. 3-5 (the `cisco-desktop` macro) | `interface GigabitEthernet1/1` / `switchport access vlan 2` / `switchport mode access` / `switchport port-security` / `switchport port-security aging time 2` / `switchport port-security violation restrict` |
| Same guide, p. 3-10 (the `cisco-router` macro) | `interface GigabitEthernet1/4` / `switchport trunk encapsulation dot1q` / `switchport trunk native vlan 4` / `switchport mode trunk` / `switchport nonegotiate` |
| [Catalyst 2960-X Auto Identity chapter, 15.2(4)E](http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960x/software/15-2_4_e/configurationguide/b_1524e_consolidated_2960x_cg/b_1524e_consolidated_2960x_cg_chapter_01010101.html) | `show running-config interface gigabitethernet2/0/6`: `switchport mode access` / `switchport voice vlan 100` / `access-session port-control auto` / ... - the voice line again after the mode, with no access VLAN to place first. |
| [Catalyst 4500 command reference, `show running-config`](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst4500/12-2/3-1-1SG/command/reference/cmdref/show1.html) | `show running-config int fastethernet 6/1` with `switchport voice vlan 2` alone in the block - a voice VLAN on a port in the default mode prints no mode line at all. |
| [Cisco tech note: "Configure Catalyst 2960/2950 Series Switches with Voice VLAN"](https://www.cisco.com/c/en/us/support/docs/switches/catalyst-2950-series-switches/113260-voice-vlan-00.pdf) | `show running-config interface fastEthernet 0/6`: `switchport voice vlan 10` / `switchport priority extend trust` / ... |
| [Cisco Community thread, book excerpt](https://community.cisco.com/t5/routing/the-command-switchport-voice-vlan/td-p/1107807) | The contradiction: `interface fastethernet 1/0/1` / `switchport trunk native vlan 99` / `switchport access vlan 10` / `switchport voice vlan 110` - native before access, and no mode line (the port was left in `dynamic auto`). |

Command-reference *procedure* steps are not evidence of output order: the same guides list
"`switchport mode` then `switchport access vlan`" as the steps to type, while the device prints them the other
way round. The samples above are output, which is the thing being modelled.

## What is known

1. The three VLAN parameters (`access vlan`, `trunk encapsulation`, `trunk native vlan`) are printed **before**
   `switchport mode`, on both an access port and a trunk.
2. `switchport voice vlan` is printed **after** `switchport mode`, and no port-security or QoS line comes
   between the mode and it.
3. A parameter whose value is the default prints nothing, and a port whose only switchport fact is a voice
   VLAN prints that one line and no `switchport mode` - the 4500 sample shows it.

## What is inferred

* **Where `switchport trunk allowed vlan` sits.** No published sample shows a trunk with an allowed list. It is
  kept with the other parameters (after `native vlan`, before `mode trunk`), which is the position the engine
  already gave it relative to them, and the only position that follows from rule 1 without a second assumption.
* **The access/native relative order.** The engine prints `access vlan` before `trunk native vlan`. The
  community book excerpt prints native first on a port staged in `dynamic auto` - a configuration that only
  exists when a parameter was typed while the port was in another mode, which is exactly the case PacketForge
  also stores and prints (a native VLAN staged on an access port). This one sample is not enough to reorder
  them, and the SXH samples never show both lines on one port.

## What is unresolved, and what would settle it

* Whether the relative order of `access vlan` and `trunk native vlan` flips when the port is in trunk mode, and
  whether `allowed vlan` precedes or follows `native vlan` on a real trunk. A single `show running-config` from
  a trunk carrying `switchport access vlan 2`, `switchport trunk native vlan 99` and
  `switchport trunk allowed vlan 10,20` on the same port would settle both - none was found in public
  documentation, and IOS 12.2SX / 15.2E output is not something this project can produce.
* `switchport nonegotiate` is printed after `mode trunk`; PacketForge has no such command, so the slot is
  documented here only so that adding one later does not have to rediscover it.

## What changed in PacketForge

`engine/cli.js`, the running-config printer: the block now reads access VLAN, trunk native VLAN, trunk allowed
list, mode, voice VLAN. Nothing about parsing, storage or round-tripping changed - the parser takes the lines in
any order, and `test/config-roundtrip.test.js` still replays the output into an identical configuration.
`test/running-config-switchport-order.test.js` holds the order, including the case where the commands were typed
in the opposite order, and the case where the voice VLAN is the port's only switchport setting.
