# `%Invalid next hop address (it's this router)` — a static route that points at the box that typed it

**Question (one, narrow).** What does IOS do with `ip route <dest> <mask> <address>` when the address is one
the router itself holds — refuse it, warn and install it, or install it silently — and in what words?

**Verdict: refused at config time, in a sentence that names no address and carries no space after the `%`.**
Nothing is installed: the line never reaches `show ip route`, `show running-config`, or the saved lab. The
model accepted the route until this run, so a lab could point a default route at the router's own address and
the table printed `S* 0.0.0.0/0 [1/0] via 10.0.0.1` — a row no box would keep.

```
Router(config)#ip route 192.168.100.0 255.255.255.0 40.0.0.1
%Invalid next hop address (it's this router)
```

## The evidence

| Typed | Printed | Source |
|---|---|---|
| `ip route 192.168.100.0 255.255.255.0 40.0.0.1` | `%Invalid next hop address (it's this router)` | https://learningnetwork.cisco.com/s/question/0D53i00000KszOlCAJ/inconsistent-address-mask |
| `ip route 1.1.1.1 255.255.255.255 93.93.13.1` | `%Invalid next hop address (it's this router)` | https://community.cisco.com/t5/routers-small-business/ip-address-of-gateway-appears-in-arp-table/td-p/3093233 |
| `ip route 0.0.0.0 0.0.0.0 192.168.1.121` (on a box whose `Fa1/0` is 192.168.1.121) | `%Invalid next hop address (it's this router)` | https://www.reddit.com/r/ccna/comments/uk9kk6/trying_to_remove_static_route_but_im_getting_no/ |
| `ip route 10.8.1.0 255.255.255.0 172.20.100.97` (172.20.100.97 is Router1's own /30 address) | `% Invalid next hop address (it's this router)` | https://www.connecteddots.online/resources/cisco/invalid-next-hop-address-its-this-router |

Four things those logs establish:

1. **The refusal is at configuration time.** The prompt returns to `(config)#` and no receipt line appears on
   a real box; the route is simply not there to show.
2. **The sentence names no address.** Unlike the `overlaps with` refusal, which prints the prefix, this one
   says only what is wrong — so the model prints no address either.
3. **There is no trailing full stop**, and the apostrophe in `it's` is ASCII.
4. **Spacing is contested, and the raw logs agree with each other.** The three raw session pastes print
   `%Invalid` with no space; the one teaching page prints `% Invalid` with a space. The model adopts the raw
   form, matching its own `Not a valid host address - ...` and `Bad mask /32 ...` siblings, which are also
   unspaced because a raw paste was the evidence.

A fifth source shows that this wording is IOS's and not universal: an ASA given `route inside 0.0.0.0 0.0.0.0
192.168.1.1` answers `%Invalid next hop address, it belongs to one of our interfaces`
(https://community.cisco.com/t5/switching/invalid-next-hop-address-it-belongs-to-one-of-our-interfaces/td-p/3062357).
This console speaks for the IOS family and prints the IOS sentence.

## What is inferred rather than witnessed

* **Which addresses count.** The rule asks "does this box hold the address", not "is the port up". A shut
  port still has its address, so a route pointed at it is still pointed at this router. No capture in hand
  shows the shut case; the model refuses it anyway and a test pins that reading, because the alternative —
  accepting a next hop that becomes the box's own address the moment the port is opened — is the defect the
  rule exists to prevent.
* **Subinterfaces count too.** An address on `Gi0/0.10` belongs to the same box; no capture shows it, and the
  model treats it exactly like a physical port's address.
* **The check runs after the whole line is parsed.** A distance, or the vendor's interface-first order, does
  not change the answer — no capture of either shape exists, but the sentence is about the next hop alone, so
  the other slots cannot matter.
* **A route already installed is not re-checked when the address is added later.** `ip route 10.9.0.0
  255.255.0.0 10.0.0.254` typed before `ip address 10.0.0.254/24` is accepted here and stays. Whether a box
  re-checks and drops it at the moment the address is assigned is not witnessed.
* **Every interface type.** Loopbacks and SVIs are not built on the routers this console offers, so the only
  addresses reachable in practice are Ethernet ones and their subinterfaces.

## What remains unresolved

* **A multicast, broadcast or otherwise reserved next hop.** `ip route 10.9.0.0 255.255.0.0 255.255.255.255`
  is accepted here (and flagged as having no interface on its subnet). A box may print a different sentence
  for a broadcast or multicast next hop — research/ip-address-host-range.md already records that the
  `Not a valid host address` family has a shorter second spelling for 224/4 on one unverifiable paste.
  **What would settle it:** one console paste each of a 224/4 and a 255.255.255.255 next hop.
* **Whether the own address later being removed or reassigned changes anything.** No evidence, and no model
  behaviour is claimed beyond the config-time check.
* **IOS XE and NX-OS.** All four pastes are classic IOS. The ASA sentence above shows the family differs by
  platform; IOS XE is assumed to inherit IOS's line, NX-OS is not checked.
* **Which spelling a current IOS XE box prints, spaced or not.** The raw-paste consensus is unspaced, but no
  capture from a 17.x box is in hand.

## What the model does now

`_addressIsLocal()` in `engine/cli.js` answers whether a dotted address is configured on any interface, and
the `ip route` branch calls it after every slot is parsed, before anything is stored:

* the line answers `%Invalid next hop address (it's this router)` — no space after `%`, no address echoed, no
  full stop;
* `device.config.routes` is untouched, so `show ip route`, `show running-config`, the gateway-of-last-resort
  line and a saved/reopened lab all agree the route was never made;
* a route that points at a *neighbour* on the same wire is accepted exactly as before, and a refusal after a
  good route leaves the good route alone.

`test/static-route-own-next-hop.test.js` (14 checks): the exact sentence for the plain, distance-bearing and
interface-first forms; nothing stored, no default row, no gateway of last resort, no line in the saved file;
the neighbour still accepted; a later refusal not disturbing an earlier route; the removal form still working;
a shut port's address and a subinterface's address both refused.
