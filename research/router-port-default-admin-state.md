# Before anyone configures it: does a router's port start up, or administratively down?

**Question (one, narrow).** In the factory default — no configuration at all — what is the *administrative*
state of a physical interface on the boxes this catalogue models, and does this simulator print the state
the box prints for the same empty configuration? The two halves that matter are a Cisco IOS/IOS-XE router
port and a Catalyst switch port, because the catalogue carries both and the vendor documents them
differently.

**Verdict: settled for Cisco IOS/IOS-XE routers and Catalyst switches, and the simulator disagrees with the
router half.** A router's physical port is **administratively down** until `no shutdown`; a Catalyst switch port
is **enabled** out of the box. PacketForge starts *every* port of *every* device enabled
(`engine/device.js:67`, `this.enabled = true`), so a fresh ISR 4331 answers `up up` on a cabled port where a
real one answers `administratively down down`. **Nothing was changed in this run**: the rule is one line, but
the migration it forces is 49 test suites and 250 assertions (measured below), which is its own increment
rather than one narrow question.

## What the vendor publishes

| Source | Says |
| --- | --- |
| [Cisco 4000 Series ISRs Software Configuration Guide, IOS XE 16.12 — Basic Router Configuration](http://www.cisco.com/c/en/us/td/docs/routers/access/4400/software/configuration/xe-16-12/isr4400swcfg-xe-16-12-book/basic_router_configuration.html) | The step-by-step for an onboard GE port ends with `no shutdown`, described as: "Enables the Gigabit Ethernet interface and **changes its state from administratively down to administratively up**." The state before the step is therefore administratively down. |
| [Cisco 4000 Series ISR guide, IOS XE 16.11.x — initial configuration](http://www.cisco.com/c/en/us/td/docs/routers/access/4400/software/configuration/xe-16-11/isr4400swcfg-xe-16-11-book/m_initconfig.html) | A `show ip interface brief` sample: `GigabitEthernet0/0/0 unassigned YES NVRAM administratively down down` — the same sentence in a table cell, on the platform whose 4331 entry this catalogue carries. |
| [Catalyst 2960-X Consolidated Platform Configuration Guide 15.2(3)E — Configuring Interface Characteristics](http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960x/software/15-2_3_e/consolidated_guide/b_1523e_consolidated_2960x_cg/b_consolidated_152ex_2960-X_cg_chapter_0101.html) | "Default Layer 2 Ethernet Interface Configuration": **Port enable state — All ports are enabled.** (Same table: trunking `dynamic auto`, native VLAN 1, PoE `Enabled (auto)`.) |
| [Cisco ASA 9.22 CLI Book 1 — Basic Interface Configuration, "Default State of Interfaces"](http://cisco.com/c/en/us/td/docs/security/asa/asa922/configuration/general/asa-922-general-config/interface-basic.html) | "In single mode … Physical interfaces—**Disabled**. VLAN subinterfaces—**Enabled**." A third platform, a third table, and the same split between the physical port and its child. |
| [Cisco 8000 Series Routers, IOS XR 7.5.x — Configuring Ethernet Interfaces](https://www.cisco.com/c/en/us/td/docs/iosxr/cisco8000/Interfaces/75x/configuration/guide/b-interfaces-config-guide-cisco8k-r75x/configuring-ethernet-interfaces.pdf) | The counter-example inside the same vendor: "**The interface default is `no shutdown`.**" (The same note adds that a newly inserted line card gets a `shutdown` item added to its configuration, so the pre-provisioning path differs - but the interface default it states is enabled.) "Cisco" is therefore not the boundary; **IOS/IOS-XE** is. |
| [Catalyst 9200/9300 command reference, `show ip interface brief` sample](http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9200/software/release/17-18/command_reference/b_1718_9200_cr/interface_and_hardware_commands.html) | `Vlan1 unassigned YES NVRAM administratively down down` beside `GigabitEthernet1/0/1 … down down`: even on a switch, the *SVI* is administratively down while the physical ports are enabled - the split the ASA table states in words. |

## What PacketForge does today

Measured on this branch's base (`586d2aa6`): one ISR 4331 cabled to one C2960X, nothing configured, no
`no shutdown` typed anywhere.

```
r1# show ip interface brief
Interface              IP-Address      OK? Method Status                Protocol
GigabitEthernet0       unassigned      YES unset  down                  down
GigabitEthernet0/0/0   unassigned      YES unset  up                    up
GigabitEthernet0/0/0-sfp unassigned    YES unset  down                  down
```

`show interfaces Gi0/0/0` agrees: `status: up, protocol: up`, `peer: sw1/Gi1/0/1`. Typing the closing form
shows the console *can* print the right cell - `administratively down down` in the brief table,
`administratively down` in the block - and `show running-config` then carries ` shutdown` under the stanza. It
simply starts every port on the wrong side of that flag.

The switch half is already right: a fresh C2960X shows `GigabitEthernet1/0/1 … up up` once cabled, which is
what "All ports are enabled" means.

## What is known

1. **Router ports: administratively down.** Two independent Cisco documents on the same product line say it
   once in prose (the closing step "changes its state from administratively down to administratively up")
   and once in a command sample (`administratively down down`), and the IOS configuration guides for every
   ISR generation carry the same `no shutdown` step.
2. **Catalyst ports: enabled.** The 2960-X defaults table states it as a table row, not as advice.
3. **The split is per interface type, not per box.** ASA: physical disabled, VLAN subinterface enabled;
   Catalyst: physical enabled, SVI administratively down. A rule keyed on "the port" alone would get two of
   those four cells wrong.
4. **The engine already encodes the subinterface half correctly.** `addSubinterface()` sets `enabled = true`
   with a comment explaining that a subinterface "has no `shutdown` line of its own" and that copying the
   parent's flag froze it (`engine/device.js:344-353`). That is exactly the ASA sentence and the IOS
   behaviour; only the physical-port default is unmodelled.
5. **The engine already has the idiom for a platform default.** `routingDefault()` (`engine/device.js:724`)
   answers "what does this box do out of the box" from vendor + category, refuses to store the answer in
   `config`, and deliberately flips only the family the vendor documented ("the documented default of a
   C9200 is not evidence for a Huawei S5720"). A port-state default belongs beside it, in the same shape.
6. **"Cisco" is the wrong key; "IOS/IOS-XE" is the right one.** IOS XR documents `no shutdown` as the interface
   default, so a `vendor === 'cisco'` test would be wrong for any XR entry the catalogue ever gains.

## What is inferred

* That the nine `category: router` Cisco entries in the catalogue (ASR 1001-X, ASR1002-X, C8000V, cBR-8,
  2811, C1111-8P, ISR4321, ISR 4331, ISR4451-X) all share the IOS/IOS-XE default. Only the 4000-series
  guide was read; the others are the same operating system family, which is inference, not a capture.
* That the two `category: firewall` Cisco entries (ASA5506, Firepower 2110) share the ASA table (physical
  disabled). The Firepower runs FTD, whose interface defaults were not read.
* That no non-Cisco router in the catalogue is affected. Nothing was gathered for RouterOS (90 entries),
  VRP (53), Peplink (54) or the rest, and this note does not claim anything about them - see the unresolved
  list.
* That the pedagogical cost is the point rather than a bug: a student who never types `no shutdown` on a router
  has not met the thing every ISR lab begins with.

## Why it is not in this run - the measured cost

A throwaway patch in the `Device` constructor (`if (spec.vendor === 'cisco' && spec.category === 'router')
iface.enabled = false;`) was applied, the full suite run, and the patch reverted. Result:

```
430 suite(s) in 207.0 s — 13671 assertions passed, 250 failed
```

49 suites fail, and they divide by what they were testing:

* **Link and port-state suites (7):** `interface-status`, `interface-drops`, `interface-counters`,
  `port-state-agreement`, `speed-duplex`, `iface-name-agreement`, `console-is-a-line-not-an-interface`.
* **Routing and adjacency suites (20):** `ospf-*` (five), `show-ospf-*` (three), `show-ip-ospf-interface-brief`,
  `show-ip-route*` (three), `route-candidate-default`, `routes-agreement`, `bgp-*` (three),
  `show-ip-bgp-argument-refusal`, `ip-default-gateway-when-routing`, `ip-address-overlap`.
* **Addressing, NAT, DHCP and ARP suites (10):** `nat-*` (four), `dhcp-*` (three),
  `show-ip-dhcp-pool-layout`, `show-arp*` (two).
* **Config, ACL and other view suites (12):** `config-roundtrip`, `running-config-end`,
  `show-access-lists*` (three), `standard-ace-host-order`, `show-lldp`, `control-plane-instant`,
  `dns-console`, `show-vrrp-*` (two), `vrrp-vip-subnet`.

The 49, in file order:

```
bgp-locprf-column                  bgp-session-link-state            bgp-summary-state-cell
config-roundtrip                   console-is-a-line-not-an-interface control-plane-instant
dhcp-binding-title                 dhcp-bindings                     dhcp-infinite-lease
dns-console                        iface-name-agreement              interface-counters
interface-drops                    interface-status                  ip-address-overlap
ip-default-gateway-when-routing    nat-ageing                        nat-cli
nat-inside                         nat-translations-total            ospf-adjacency-link-state
ospf-default-cost                  ospf-priority                     ospf-route-metric
ospf-timer-mismatch                port-state-agreement              route-candidate-default
routes-agreement                   running-config-end                show-access-lists
show-access-lists-numbering        show-access-lists-standard-address-form show-arp
show-arp-local-address             show-ip-bgp-argument-refusal      show-ip-dhcp-pool-layout
show-ip-ospf-interface-brief       show-ip-route                     show-ip-route-interface-spelling
show-ip-route-prefix-one-field     show-lldp                         show-ospf
show-ospf-interface-not-enabled    show-ospf-interface-shut-port     show-vrrp-election
show-vrrp-owner-priority           speed-duplex                      standard-ace-host-order
vrrp-vip-subnet
```

Every one of those is a fixture that addressed a router port and expected traffic without ever typing
`no shutdown`. Each needs the line added *and* its expectations re-read: several of them assert the very `up`
this change removes, and a mechanical insertion would leave the suite green while testing something other
than what its comment says. That is a migration with its own review, not a one-question increment - and it
is the reason this note exists instead of a diff.

## Where the rule would live

* A `portsShutByDefault()`-style predicate beside `routingDefault()` (`engine/device.js:724`), keyed on the
  documented families (`cisco` + `router` for IOS/IOS-XE; `cisco` + `firewall` for ASA once FTD is checked),
  returning the factory answer rather than storing it in `config`.
* `Interface` would ask the device instead of hard-coding `this.enabled = true` (`engine/device.js:67`) - it
  already receives `deviceSpec` for `derivePortHardware()`, and a device-level default is a constructor
  argument away.
* Subinterfaces keep `enabled = true` at creation (`engine/device.js:353`), which is both IOS's and the
  ASA's documented shape.
* `show running-config` then has to print a `shutdown` line per physical port on an unconfigured router - which
  is what a real box's config carries, and is a second surface the same migration has to touch.

## What remains unresolved

* **Non-Cisco router defaults.** RouterOS, VRP, Peplink, Teltonika, Juniper: no capture read, no claim made.
  The `routingDefault()` precedent argues strongly against extrapolating from the Cisco answer.
* **Port-channel and loopback interfaces**, and the ISR's chassis port `GigabitEthernet0` (which the real
  4000-series samples also list). No sample in hand separates their defaults from the physical ports'.
* **Huawei VRP.** `undo shutdown` exists in the grammar; whether a factory AR port starts enabled was not
  measured.
* **The SVI cells** are already their own note ([svi-vlan1-default-state.md](svi-vlan1-default-state.md)):
  this console has no SVI object, and the captures disagree on `administratively down` versus `down` versus
  `up` for `Vlan1`. Not re-opened here.

## What evidence would settle the rest

1. `show ip interface brief` from a factory-default Huawei AR and a MikroTik CCR, one each - does a cabled
   port read `up up` or `administratively down down`?
2. A factory-default `show running-config` from an ISR 4331, to confirm the `shutdown` line under every
   `GigabitEthernet0/0/x` and to see what `GigabitEthernet0` carries.
3. The same from a Firepower running FTD, for the `firewall` half.
