# `ip routing`: the state a box is in before anybody configures it

**Question.** The console prints two different `show ip route` shapes, one for a box that routes and one for a box
that does not. Which boxes are in which state before any configuration, and what should the simulator answer?

**Short answer.** It is a platform fact, not a universal one. A Cisco router routes out of the box; a Catalyst switch
with L3 hardware does not, and stays a Layer 2 box until somebody types `ip routing`. The console now models both
answers and the command that moves between them; the *default* is claimed only for the platforms whose own
documentation states it, and the rest of the catalogue is left alone (see *Unresolved*).

## What is known

### A Catalyst switch is in Layer 2 mode out of the box

* Catalyst 3560 Software Configuration Guide, *Configuring IP Unicast Routing*:
  > By default, the switch is in Layer 2 switching mode and IP routing is disabled. To use the Layer 3 capabilities
  > of the switch, you must enable IP routing.
  https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst3560/software/release/15-0_2_se/configuration/guide/scg3560/swiprout.html
  The same sentence appears in 12.2(25)SEA, 12.2(52)SE, 15.0(1)SE and the 3750-X/3560-X guide.
* IP Routing Configuration Guide, Cisco IOS XE 26.x (Catalyst 9300), which has both the prose and a defaults table:
  > By default, IP routing is disabled on the device, and you must enable it before routing can take place.
  and, in the table, `IP routing | Disabled.`
  https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9300/software/release/26-x/configuration_guide/rtng/b_26x_rtng_9300_cg/configuring_ip_unicast_routing.html
  (17.14 says the same: https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9300/software/release/17-14/configuration_guide/rtng/b_1714_rtng_9300_cg.pdf)
* Catalyst 3560 *Troubleshooting*, on `ping`:
  > IP routing is disabled by default on all switches.
  https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst3560/software/release/15-0_1_se/configuration/guide/scg3560/swtrbl.html

A community transcript on a 3750 makes the same point from the console side: "On the Catalyst 3750, IP Routing is
disabled, hence when I do `show ip route`, it gives the 'Default Gateway' output."
https://community.cisco.com/t5/switching/cisco-catalyst-4506-default-gateway-doesn-t-work/td-p/1752479

### A router routes out of the box

* Cisco IOS IP Routing: Protocol-Independent Command Reference, `ip routing`, **Command Default**:
  > IP routing is enabled.
  https://www.cisco.com/c/en/us/td/docs/ios/iproute_pi/command/reference/iri_book/iri_pi1.html
* And the default is *not* printed, which is why a router's `show running-config` has no `ip routing` line even
  though it routes: "This happens because `ip routing` is enabled by default. You can't see it with
  `show running-config` because it's enabled by default, but you can see it when you use the `all` option."
  https://networklessons.com/ip-services/cisco-router-as-host-or-server

### `no ip routing` is what produces the second shape

A router with routing switched off prints exactly the table a Catalyst prints out of the box:

```
R1(config)#no ip routing
R1(config)#end
R1#show ip route
Default gateway is not set
Host               Gateway           Last Use    Total Uses  Interface
ICMP redirect cache is empty
```

https://community.cisco.com/t5/switching/cisco-catalyst-4506-default-gateway-doesn-t-work/td-p/1752479
https://networklessons.com/ip-services/cisco-router-as-host-or-server
https://networklessons.com/cisco/ccnp-route/how-to-configure-static-nat-on-cisco-ios-router

and its static routes stay in the configuration while failing to install: "the static routes you enter afterwards
will remain in the running config but won't make it to the routing table as it is no longer a router now."
https://learningnetwork.cisco.com/s/question/0D53i00000KsrT5CAJ

### The command does not exist everywhere

A Catalyst 2960 has no `ip routing` line at all - it has no L3 forwarding to enable - so the console refuses it with
its usual capability sentence rather than storing a setting nothing would consult.

## What was changed

* `Device.isL3()` is now `hasCap('l3-forward') && ipRoutingEnabled()`. Every consumer - `show ip route`, the L3 data
  path, the IPv6 router-advertisement walk, the installed-route table - already asked `isL3()`, so one flag moves
  them together and they cannot disagree.
* `Device.routingDefault()` answers the platform question in one place: `false` for a Cisco `l3-switch` category
  entry, `true` for everything else. `config.ipRouting` holds only what an operator said (`null` = nothing said).
* `ip routing` / `no ip routing` in config mode, capability-gated, with a receipt; a trailing word is refused.
* `show running-config` prints `ip routing` or `no ip routing` only when the state differs from
  `routingDefault()` - the rule the rest of the file follows, and the reason a router's own config never showed it.
* The flag is saved and restored; a document that says nothing does not grow the field.
* `test/ip-routing.test.js` (37 assertions) pins the default per platform, the two table shapes, the data path, the
  static-route behaviour, the printed line, and the save/reload round trip.

## What is inferred

* That the difference is a *category* fact rather than a per-model one. Cisco states it in the configuration guide
  of each family, and the sentence is identical across 2960-era IOS and IOS XE 26.x; treating "Cisco L3 switch" as
  one class is an inference from that repetition, not a sentence any one document states.
* That a Catalyst's `ip routing` line is what a *failed* ping across VLANs should be blamed on. The 3560
  troubleshooting chapter says "you must define a static route ... or have IP routing configured", which is the
  same claim in the vendor's words, but no transcript in hand shows the failed-ping output.

## Unresolved

1. **The other 216 `l3-switch` entries.** 264 catalogue entries carry `l3-switch`; 48 of them are Cisco. Whether a
   Huawei S5720, an Arista 7050X or a Juniper EX3400 leaves the factory forwarding is not something the citations
   above say, so all of them keep the pre-existing answer (`true`). Claiming otherwise would be inventing a default
   for another vendor on the strength of a Cisco document.
2. **The Cisco `switch`-category boxes with L3 forwarding** - the ten C1000/IE-3300 models. Their own guides were not
   read for this note, so they also stay at `true`.
3. **`show running-config all`.** The router's enabled-by-default state is only visible through `all` on a real box,
   and this console has no `all` view. A reader who knows IOS may expect `ip routing` in the plain file on a router;
   it is absent for the documented reason, not by omission.
4. **What the *saved* config of a never-configured Catalyst looks like.** We write no `ip routing` line, matching
   "the default is not printed"; a real 3560's `show running-config` on a factory box is also silent, per the
   transcripts, but no primary capture of that specific output is in hand.

## Evidence that would settle it

* A `show running-config` and `show ip route` from a factory-default C9200 or C9300, pasted whole.
* The *Configuring IP Routing* chapter (or defaults table) for the C1000, IE-3300, S5720 and EX3400 families.
* Any transcript of a failed inter-VLAN ping on a Catalyst with routing disabled, to confirm the wording the
  operator sees is the same "not routable" sentence this console emits.
