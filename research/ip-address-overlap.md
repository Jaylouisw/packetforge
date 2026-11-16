# One subnet, one wire: which `ip address` collisions a box refuses

**Question (one, narrow).** A router holds one connected route per subnet, so two of its ports cannot hold
addresses in the same subnet. What exactly does IOS refuse, what does it print, what does it leave behind —
and which part of that can this model reproduce without inventing the rest?

**Verdict: known, and adopted for the primary-address case.** A second primary address in a subnet another
port on the same box already holds is refused with one line — `% <attempted network> overlaps with <port>` —
and nothing is applied. Two consequences of the rule are *not* settled by anything in hand and are stated
below instead of being modelled: an incumbent port that is administratively down, and an address a DHCP
client holds at run time.

## The evidence

Three public transcripts, from three different people, print the same sentence with the same shape:

| Typed | Incumbent | Printed |
|---|---|---|
| `ip address 192.168.254.32 255.255.255.192` | `192.168.254.1 255.255.255.192` on `FastEthernet0/0` | `% 192.168.254.0 overlaps with FastEthernet0/0` |
| `ip add 10.1.1.2 255.255.0.0` | `10.1.1.1 255.255.0.0` on `GigabitEthernet0/0` | `% 10.1.0.0 overlaps with GigabitEthernet0/0` |
| `ip address … 255.255.255.128` on `GigabitEthernet0/1.10` | `192.168.1.x` on `GigabitEthernet0/1` | `% 192.168.1.0 overlaps with GigabitEthernet0/1.10` |

* https://learningnetwork.cisco.com/s/question/0D53i00000Kt12sCAB/can-one-subnet-be-on-opposite-sides-of-a-router
* https://learningnetwork.cisco.com/s/question/0D53i00000Ksv3lCAB/two-interfaces-on-the-same-subnet
* https://learningnetwork.cisco.com/s/question/0D53i00000KsxMfCAJ/subinterfaces

Four things are established by those transcripts rather than inferred from them:

1. **The number is the attempted network, under the attempted mask.** `10.1.1.2 255.255.0.0` prints
   `10.1.0.0`, not `10.1.1.0`; `192.168.254.32 255.255.255.192` prints `192.168.254.0`. Both are the network
   of the address being typed under the mask being typed.
2. **The port that got there first is named**, in the spelling it was configured under.
3. **Nothing is applied.** The first transcript runs `show ip int bri` after the refusal: the second port is
   still `unassigned`, the first is unchanged.
4. **A subinterface collides like a port.** The third transcript is a `Gi0/1.10` subinterface against its own
   parent, so the rule is about the routing table, not about physical ports.

The reason the box refuses is stated plainly by the same sources and by Cisco's own teaching material: the
connected route for the subnet would have two next hops, so routing could not say which wire to send by.

## What this model now does

`_ipOverlapRefusal()` in `engine/cli.js` runs on `ip address <address> <mask>` before anything is stored:

* compares the **ranges**, not the prefixes — `start <= otherEnd && otherStart <= end` — so `10.1.1.1/16`
  and `10.1.2.1/24` collide in either order, which "same subnet" would miss;
* compares against every other interface on the same device that holds a static address, subinterfaces
  included, and names the first one it finds in hardware order;
* prints `% <network> overlaps with <port>` and returns before the port is touched, so `iface.ip`, `iface.mask`
  and the DHCP flag keep their previous values and `show running-config` never carries the refused line.

`test/ip-address-overlap.test.js` — 14 checks: the exact line, the unchanged port in
`show ip interface brief` and in `show running-config`, the two containment directions, adjacent /25s
allowed, a port re-addressed on itself, the subnet freed by `no ip address`, a second device in the same
subnet, and a subinterface against its parent.

## What is unresolved

* **An administratively down incumbent.** One contributor says the overlap is accepted "until one of the
  interfaces is set to administratively shutdown", which would mean a shut port does not reserve its subnet.
  That is one sentence from one person, contradicted by no one and confirmed by no vendor page and no capture
  either. This model keeps the rule it can cite — every interface holding an address blocks its subnet
  whatever its admin state — because the alternative would let a lab build two connected routes for one
  network by closing a port first, which no source demonstrates.
  *What would settle it:* a transcript on a current IOS/IOS XE image — shutdown on the incumbent, then the
  second `ip address` — showing either the same refusal or an accepted address.
* **An address a DHCP client holds at run time.** The check happens while the address is typed, and a lease
  does not exist yet, so a static address that lands on a leased subnet after a run is not caught here. A real
  box would not know either at configure time; whether it refuses later, when the lease arrives, is a question
  about the DHCP client's behaviour, not about this rule.
* **Secondary addresses.** IOS lets one interface carry several subnets with `ip address … secondary`, and a
  secondary address may legitimately sit beside another interface's subnet in some designs. This model has no
  `secondary` keyword, so the rule needs no exception for one — and the day it does, the exception belongs
  with the keyword, not here.
* **VRFs.** Overlapping subnets across VRFs are explicitly allowed by IOS (Cisco's VRF guides say so at
  length), and this model has no VRF, so nothing here can collide across one.
