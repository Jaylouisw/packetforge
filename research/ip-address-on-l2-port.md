# `ip address` on a switchport: the box that refuses it, and the address this console accepts and never answers

**Question (one, narrow).** On a Cisco IOS *switch* whose port is a Layer 2 switchport, what happens when an
operator types `ip address <address> <mask>` at `(config-if)#` — is it accepted, or refused, and in what words?
And the second half, which is about this repo: what does PacketForge do with the same line today, and does the
console and the data path agree about what the line means?

**Verdict: known for the vendor, and this console is wrong in a way a refusal alone cannot fix.**
IOS refuses the line on a switchport with one sentence, `% IP addresses may not be configured on L2 links.`, and
the address has to go on an SVI (`interface vlan <id>`) or on a port that has been made routed (`no switchport`,
where the platform has it). PacketForge accepts the line on **every** port of a box that cannot route, prints the
address on four surfaces (running-config, `show interfaces <port>`, `show ip interface brief`, `show arp`), and
then never answers for it: a host on the same VLAN gets `no ARP reply from 10.0.0.1 x5`. The same line on a box
with `l3-forward` is accepted *and* answered, so the console's answer is decided by nothing while the data path's
answer is decided by the capability — the two disagree exactly where the catalogue says the box is a bridge.

It was **not** changed in this run. A blanket refusal would be wrong for a large, real family of L2-only boxes
whose management address sits on a routed `mgmt0` port (Brocade, Connectrix, MDS — 526 catalogue entries carry
`l2-forward` with neither `l3-forward` nor `host`), this console has no SVI for the 2960's address to move to, and nothing in the
catalogue says which of a box's ports is a switchport and which is a management port. What the fix needs is
recorded below; the code is untouched because the next line of it would have been invented.

## What is known

### The refusal, and its exact words

Three independent captures of the same sentence, from three different platforms:

| Source | Transcript |
|---|---|
| Cisco Community, 2024, ISR with an EHWIC-4ESG switch module — [td-p/5113898](https://community.cisco.com/t5/routing/ip-addresses-may-not-be-configured-on-l2-links/td-p/5113898) | `TesTR1(config-if)#ip address 192.168.5.10 255.255.255.0` / `% IP addresses may not be configured on L2 links.` — and the answer that follows: "you have to add the commande `no switchport` under the interface before assigning ip addresse" |
| Cisco Community, 3745 + NM-16ESW — [td-p/1041716](https://community.cisco.com/t5/switching/nm-16esw-1g1g-module-installed-on-router/td-p/1041716) | `(config-if)#no switchport MODE` / `(config-if)#no switchport access vlan 1` / `(config-if)#ip address 10.10.10.1 255.255.255.0` / `% IP addresses may not be configured on L2 links.` — then the working alternative: "just define a VLAN, assign it an ip address and add this port to that VLAN" |
| Cisco Learning Network, 837 — [question thread](https://learningnetwork.cisco.com/s/question/0D53i00000Kt0YRCAZ/cisco-837-and-ip-addresses-may-not-be-configured-on-l2-links-error) | "those 4 ports, fa1-4, they are layer 2 only, you cannot assign an ip to them, you must assign an ip to the vlan interface or SVI" |

The message is also printed verbatim in a CCNP course deck next to the fix — [ipcompro.net, SWITCH slides,
"Inter Vlan Routing and DHCP"](https://www.ipcompro.net/IpComPro/Training-Materials/Cisco/CCNP-RS/SWITCH/Slides/03%20SWITCH%20Inter%20Vlan%20Routing%20DHCP.pdf):

```
Switch(config)# interface GigabitEthernet 1/2
Switch(config-if)# ip address 10.20.1.254 255.255.255.252
% IP addresses may not be configured on L2 links.
Switch(config-if)# no switchport
Switch(config-if)# ip address 10.20.1.254 255.255.255.252
```

So the sentence is stable across module, router-with-switch-module and switch, and it is *not* followed by a
second explanatory line — one `%` line, then the prompt.

### What the operator must do instead

* **SVI.** The Catalyst 2960 guide's own procedure for a switch's address is `interface vlan <vlan-id>` →
  `ip address` → `ip default-gateway`, under the heading "Manually Assigning IP Information", which is introduced
  as the steps "to manually assign IP information to multiple switched virtual interfaces (SVIs)" —
  [Catalyst 2960 15.2(1)E, *Assigning the Switch IP Address and Default Gateway*](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960/software/release/15-2_1_e/configuration/guide/2960_scg/swipaddr.html).
  The same guide states the hardware limit without room for reading: "Static routing is supported only on switched
  virtual interfaces (SVIs) and not on physical interfaces" —
  [Catalyst 2960/2960-S 12.2(58)SE, *Configuring Static IP Routing*](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960/software/release/12-2_58_se/configuration/guide/2960scg/swipstatrout.html).
* **A routed port, on platforms that have one.** The 2960-XR/9300 procedure is explicit: "If the physical port is
  in Layer 2 mode (the default), you must enter the `no switchport` interface configuration command to put the
  interface into Layer 3 mode", then `ip address` —
  [Catalyst 2960-XR 15.2(6)E consolidated guide, *Configuring Interface Characteristics*](http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960xr/software/15_2_6_e/configuration_guide/b_1526e_consolidated_2960xr_cg/m_int_inter_cg.html).

### The other family: an L2-only box that *does* take an address on a port

Fibre Channel switches switch frames and have no `l3-forward` in this catalogue's sense, yet their management
address is configured on the port itself:

* Cisco MDS 9000, *Configuring IP Services*: "**IP forwarding on the out-of-band Ethernet interface (mgmt0)**",
  procedure `switch(config)# interface mgmt0` → `switch(config-if)# ip address 10.1.1.1 255.255.255.0` →
  `no shutdown` —
  [MDS 9000 NX-OS 9.x IP Services guide](https://www.cisco.com/c/en/us/td/docs/dcn/mds9000/sw/9x/configuration/ip-services/ipsvc/ipsvc_chptr.html).
* Brocade Fabric OS: "you must set the Ethernet and chassis management IP interfaces" on the management Ethernet
  port (`ipaddrset`, or `ethif`/`bond0` on directors) —
  [Fabric OS Administration, *Performing Basic Configuration Tasks*](https://techdocs.broadcom.com/us/en/fibre-channel-networking/fabric-os/fabric-os-administration/9-1-x/Performing-Basic-Configuration-Tasks-Admin1/v26746158/v26746177.html).

That is the same shape of box as a 2960 in this catalogue — `l2-forward` and nothing else — and `ip address` on
its `mgmt0` is the *correct* command, not the refused one. Whatever rule the console applies has to tell
`Fa0/1` and `mgmt0` apart, and no field in the catalogue does.

## What PacketForge does today, measured

A `Catalyst2960` (so: `l2-forward,cli`), one PC on `Fa0/2`, an address typed on `Fa0/1`:

```
SW1(config)#interface Fa0/1
SW1(config-if)#ip address 10.0.0.1 255.255.255.0
IP address set on Fa0/1: 10.0.0.1/24
SW1(config-if)#end

PC-A#ping 10.0.0.1
Sending 5, 100-byte ICMP Echos to 10.0.0.1, timeout is 2 seconds:
.....
Success rate is 0 percent (0/5)
% Echoes lost: 5 drops (no ARP reply from 10.0.0.1 x5)
```

The console does not merely store it quietly. Four readers report the address as if it were in force:

```
SW1#show ip interface brief
Interface              IP-Address      OK? Method Status                Protocol
Fa0/1                  10.0.0.1        YES manual down                  down

SW1#show interfaces Fa0/1
Fa0/1 (ethernet, 100M), MAC 0200.0000.0000
  ip: 10.0.0.1/24

SW1#show arp
Protocol  Address          Age (min)  Hardware Addr     Type    Interface
Internet  10.0.0.1         -          0200.0000.0000    ARPA    Fa0/1
```

and `show running-config` prints `ip address 10.0.0.1 255.255.255.0` under `interface Fa0/1`, so the line
survives a save and a reload. Only the wire disagrees, and the wire is right: `engine/simulator.js` terminates an
address on an L2 device only when `dev.hasCap('l3-forward') || dev.isHost()` — a bridge that is neither is left
to forward the frame and never offer it to a local stack.

The same line on the same port config, three other boxes in the catalogue:

| Model | Capabilities | `ip address` on a port | Ping from a host in the same VLAN |
|---|---|---|---|
| C1000-24P-4G-L | `l2-forward,l3-forward,…` | `IP address set on Gi1/0/1: 10.0.0.1/24` | `Success rate is 100 percent (5/5)` |
| CX 6000 24G 4SFP | `l2-forward,cli,http-server` | `IP address set on 1/1/1: 10.0.0.1/24` | `Success rate is 0 percent (0/5)` |
| LMP-1002G-SFP (industrial) | `l2-forward,cli,…` | `IP address set on port1: 10.0.0.1/24` | `Success rate is 0 percent (0/5)` |

Two more measurements worth recording, because they show the two obvious escape routes are closed in this build:

* `interface Vlan 1` on the 2960 answers `% Interface not found: Vlan 1`. There is no SVI anywhere in the engine
  (`grep -n "Vlan" engine/cli.js` finds no interface-creation path), so the address has no home a real box would
  accept.
* `no switchport` on the 2960 answers `% Fa0/4 already has default switchport settings (access VLAN 1)` — it
  resets switchport configuration, it does not turn the port into a routed one (`engine/cli.js`, `_switchport`,
  the `!leaf.length` branch). So the 2960-XR procedure cannot be followed here either, and the address then goes
  on the port as before.

The line is accepted on a trunk port as well — `switchport mode trunk` + `switchport trunk allowed vlan 10,20` +
`ip address` answers `IP address set on Fa0/3: 10.0.0.1/24` — so the divergence is not confined to access ports,
and `ip address dhcp` is accepted on the same port (`Interface Fa0/4 set to DHCP`).

## Why the fix is not a one-line refusal

The obvious patch — refuse `ip address` on any port of a box without `l3-forward` — was written, measured
against the catalogue and dropped, for three reasons that are all facts about this repo rather than about IOS:

1. **526 catalogue entries carry `l2-forward` with neither `l3-forward` nor `host`**, and several families configure their management address on the
   port: `mgmt0` on the Brocade G610, the Cisco MDS 9124V/9148S, the Dell/Connectrix DS-6630B. On those boxes
   the vendor's own procedure is `interface mgmt0` / `ip address <a> <m>` (MDS guide above), so refusing would
   print a sentence the hardware never prints, about a command the hardware takes.
2. **Nothing in the catalogue says which port is which.** A port carries `name`, `type`, `speed`, `connector`,
   `speedCaps` — no role. `Fa0/1` and `mgmt0` are both `ethernet` with an `rj45` cage, and the engine fills the
   same default `vlan` object (`{mode:'access', accessVlan:1, nativeVlan:1, allowedVlans:'all'}`) on a router's
   `Gi0` as on a switch's `Fa0/1`, so the port object cannot separate a switchport from a routed port.
3. **The 2960 has nowhere to put the address.** Refusing without an SVI would leave every Catalyst 2960 in the
   catalogue with no way to hold an address at all, which is a *feature* being removed to fix a fidelity bug —
   and `test/l3-switch-management.test.js` exists precisely because the console is expected to answer for a
   switch's own address.

The part that could be fixed without any of that is the data plane: make an L2-only box terminate an address it
holds on a port (adding "owns an address on this port" to `canTerminate`). That would make `ping 10.0.0.1`
succeed on the 2960 — faithful for `mgmt0` boxes, and *unfaithful* for the 2960, where the command that put the
address there is the one the vendor refuses. Either half alone moves the lie rather than removing it.

## What a fix would need

1. **A port role in the catalogue** — at minimum `switchport` versus `routed`/`management`, per port, because that
   is the fact that decides both halves. The schema already carries per-port `connector`/`speedCaps`, so a
   `role` (or `l3: true` on the ports that take an address) is a small addition; the value has to come from the
   vendor's port table, not be inferred from the name.
2. **Then the rule splits cleanly.** A port whose role is `switchport` refuses `ip address` with the vendor's one
   sentence; a port whose role is `routed`/`management` accepts it and the data path answers (`canTerminate`
   already asks `l3 || isHost`, and a routed management port is the third case).
3. **And, longer term, `interface Vlan <id>`** so the 2960's address has the home a real box gives it, and
   `show ip interface brief` can print the `Vlan1` row the MDS/2960 captures all show. That is a feature, not a
   fidelity fix, and it is out of scope for this run.

## What is inferred

* **The order of the refusal against value validation.** This console validates the mask and the host-address
  rule before anything else (`_ipHostRefusal`, `_ipOverlapRefusal`), and that order is invisible on a real box
  unless a line is wrong in two ways at once — `ip address 10.0.0.0 255.0.255.0` on a switchport would say either
  `% Invalid mask` or the L2 sentence depending on which check the parser runs first. No capture found shows a
  doubly-wrong line, so nothing here is settled.
* **That mgmt0 is routed on the hardware the catalogue names.** The MDS guide says so in its own words; the
  Brocade and Dell pages describe the management Ethernet address without using the word "routed". The rule above
  assumes "management port takes an address" for all three, which is stronger than what the pages state for the
  Brocade/Dell boxes.
* **That the sentence is printed alone.** All three captures show one line and then the prompt. None shows a
  second line, and this console's house style (a `%` sentence plus a pointer) is therefore *not* what a reader
  comparing against hardware would see.

## What remains unresolved, and what evidence would settle it

* **Whether the LAN Base 2960 image has `no switchport` at all.** The routed-port procedure is documented for the
  2960-XR and the 9300; the 2960-S chapter only says routing happens on SVIs. A `?` listing or a refused command
  on a 2960 LAN Base 15.2(7)E would settle whether "use `no switchport`" is advice a 2960 student can follow.
* **Which of the 526 L2-only models take an address on a port.** That is a per-model census of port roles, which
  is exactly the field the fix needs; without it the size of the `routed`/`management` set is unknown.
* **`ip address dhcp` on an L2 switchport.** A 2960 takes `ip address dhcp` on the management SVI; whether the
  same line on `Fa0/1` prints the L2 sentence or a DHCP-specific one was not captured anywhere found.
* **The wording on other vendors.** Huawei (`Error: …`) and HPE/Aruba (`ip address` under `interface vlan`) have
  their own sentences for the same rule; this console speaks one IOS grammar for every vendor, so the sentence
  above would be printed on all of them, as it already is for the config-mode greeting. That consistency is a
  decision, not evidence, and the pages that would test it were not fetched.
* **What a real box prints for an address on a *router* port of a switch module after `no switchport`** — the
  captures show the retyped `ip address` being accepted in silence, which matches this console's "no answer means
  it worked" reading of `ip address`, but only one of the three threads shows the prompt after it.
