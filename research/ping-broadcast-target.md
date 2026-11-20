# `ping` a broadcast address: refused, or sent - and what the report looks like

**Question (one, narrow).** When a Cisco-style box is told to `ping` an address that is not *one* host - the all-ones
broadcast `255.255.255.255`, a connected subnet's broadcast or network address, or a multicast group - does it refuse
the command, does it send it, and what does it print for the answers?

**Verdict: settled for the main case, and the engine is wrong about it - but not fixed here.** The address is never
refused. The echo is put on the wire as a link-layer broadcast (or multicast), every host that answers gets its own
line, and the report switches shape: one `Reply to request <n> from <address>, <ms> ms` line per reply **instead of**
the marks line and the success-rate line. `engine/simulator.js`'s `ping()` is a one-echo/one-reply model, so adopting
this is a change to the report model rather than a wording fix, and one case the lab needs most - a broadcast ping that
nobody answers - has no capture at all. Recorded, not implemented.

## The shape, character for character

```
R1#ping 255.255.255.255 rep 1
Type escape sequence to abort.
Sending 1, 100-byte ICMP Echos to 255.255.255.255, timeout is 2 seconds:
Reply to request 0 from 192.168.0.2, 64 ms
Reply to request 0 from 192.168.0.6, 68 ms
Reply to request 0 from 192.168.1.8, 68 ms
Reply to request 0 from 192.168.0.5, 68 ms
R1#
```

Four things are visible in that block, and each of them is a rule:

* the send line is the ordinary one - same wording, same `timeout is 2 seconds:`;
* the marks line is **absent**: no `!!!!!`, at any point in the report;
* each answer is its own line, naming the *responder's* address, not the address that was typed;
* the report **ends at the last reply line**: the prompt follows immediately, with no `Success rate is ...` between
  them. That is the one part of the shape a paste settles only because the prompt was captured.

The requests are counted, and replies are grouped by the request they answer: a five-echo run to `255.255.255.255`
lists every answer to request 0, then every answer to request 1, and so on.

## Evidence

| Source | Shows | What it settles |
| --- | --- | --- |
| [IP With Ease, "Broadcast and Network PING Command"](https://ipwithease.com/broadcast-and-network-ping-command/) | Three runs from one router on two segments: `ping 192.168.0.0 rep 1`, `ping 192.168.0.255 rep 1`, `ping 255.255.255.255 rep 1`. Every one of them prints `Reply to request 0 from 192.168.0.5, 72 ms`-style lines and nothing else, and the transcript **closes with the `R1#` prompt directly under the last reply** | The report shape; the absence of both the marks line and the success rate; that the all-ones ping is answered from *both* attached subnets (`192.168.0.2` … `192.168.1.8` in the same list) |
| [Cisco Learning Network, "What's the broadcast used for?"](https://learningnetwork.cisco.com/s/question/0D53i00000Ksy8xCAB/whats-the-broadcast-used-for) | `IOU6#ping 255.255.255.255` with the default five echoes: seventeen `Reply to request n from 192.168.0.2/.3/.4, <16-27> ms` lines, grouped 0, 1, 2, 3, 4 | That the per-request grouping is real (three responders x five requests), that the same run answers more than one host per request, and that the millisecond field varies per reply |
| [Cisco, "Troubleshoot Multicast Networks with CLI Tools" (doc 13726)](https://www.cisco.com/c/en/us/support/docs/ip/ip-multicast/13726-57.html) | `R3#ping 239.255.0.1` -> `Reply to request 0 from 172.16.12.2, 16 ms` / `Reply to request 0 from 172.16.7.2, 20 ms` | The same form for a **group** address, from a vendor page rather than a forum paste - and two responders in *different* subnets, so the form is not about being on the same wire |
| [Cisco Community, "Ping network address"](https://community.cisco.com/t5/other-network-architecture-subjects/ping-network-address/td-p/183017) | `HUB#ping 172.16.10.0` -> one `Reply to request 0..4 from 172.16.10.2, 1 ms` per request; the poster adds "if it is a directly connected, broadcast network, you get replies from each device … when pinging a network address … more than two hops away, you just get the !!! symbol" | That the **network** address behaves like the broadcast address of the same subnet, and the local-vs-remote distinction in the poster's own words |
| [Cisco Learning Network, "routers and direct broadcast"](https://learningnetwork.cisco.com/s/question/0D53i00000Kt6etCAB/routers-and-direct-broadcast) | `R1#ping 10.0.0.255` (directly connected) -> five reply lines from `10.0.0.2`; then `ping 23.0.0.255` (a subnet R1 is *not* attached to) -> `!!!!!` / `Success rate is 100 percent (5/5), round-trip min/avg/max = 8/52/124 ms` | The discrimination: the marks line and the rate are what a box prints when it **cannot tell** the address is a broadcast of a wire it is on. The decision to broadcast is made from the box's own interface addresses, not from where the answer came from |
| [Cisco Community, "Broadcast Address"](https://community.cisco.com/t5/switching/broadcast-address/td-p/2311356) | `SW1#ping 192.168.0.255` -> `Reply to request 2 from 192.168.0.3, 2 ms` / `.4` / `.5` - replies only for request 2 | That a reply line is printed as it arrives, so a run can name one request and not others; the report is a log, not a table |
| [Cisco Community, "How to find the IP address of a device…"](https://community.cisco.com/t5/switching/how-to-find-the-ip-address-of-a-device-connected-to-a-specific/m-p/1855626) | `core#ping 192.168.1.255` -> reply lines from `192.168.1.113`, `192.168.1.239`, `192.168.220.19`, `192.168.0.51`, … | A second paste of the same shape on a different box, from an SVI, with responders on several subnets of one wire |

## What is known

1. **The command is accepted.** No source in hand shows a refusal for any of these addresses; four independent boxes
   (IOU, a lab router on two LANs, a switch SVI, a multicast router) print replies to them.
2. **The report shape changes.** With a broadcast target the box prints `Reply to request <n> from <addr>, <ms> ms`,
   one line per answer, and prints **no marks line**.
3. **There is no success-rate line either**, at least in the one paste whose prompt is visible
   ([ipwithease](https://ipwithease.com/broadcast-and-network-ping-command/)). The other pastes stop at the same place
   but were possibly trimmed, so the strength of this claim rests on that one prompt.
4. **The network address of a connected subnet behaves like its broadcast address** - replies come from the hosts, not
   from the network address, and the box never complains that the address is not a host.
5. **`255.255.255.255` is delivered to every attached subnet** that can carry a broadcast: the ipwithease run from a
   two-LAN router lists responders from both `192.168.0.0/24` and `192.168.1.0/24`.
6. **A group address takes the same path**: `ping 239.255.0.1` prints reply lines named for the members that answered,
   and they need not be on the sender's subnet (Cisco doc 13726).
7. **A remote subnet's all-ones address is *not* recognised as a broadcast** by a box with no interface in that subnet:
   the echo is routed as an ordinary unicast datagram, the router that owns the subnet answers, and the report is the
   familiar `!!!!!` plus `Success rate is 100 percent (5/5), round-trip min/avg/max = …`.

## What is inferred

* The trigger for "broadcast mode" is the set of addresses the box can *prove* are not one host: `255.255.255.255`, and
  the all-ones/all-zeros address of each connected subnet, plus group addresses. This is the reading that fits all
  seven sources above, including the one that disagrees on the surface (item 7).
* The success rate is omitted because a broadcast run has no single denominator - N echoes went out and M replies came
  back per echo - rather than because the box forgot to print it.
* Reply order is arrival order (the ipwithease list is not in address order, and the request-2-only paste shows lines
  appearing as they arrive), so a simulator would have to order by the round trip its own model computes.

## What PacketForge does today

Measured on the `ping-report-shape` lab (a router, two PCs and a switch on `10.0.0.0/24`, `h2` alive at `10.0.0.2`):

```
h1# ping 10.0.0.255
Type escape sequence to abort.
Sending 5, 100-byte ICMP Echos to 10.0.0.255, timeout is 2 seconds:
.....
Success rate is 0 percent (0/5)
% Echoes lost: 5 drops (no ARP reply from 10.0.0.255 x5)

h1# ping 255.255.255.255
...
% Echoes lost: 5 drops (no route to 255.255.255.255 x5)

h1# ping 224.0.0.1
...
% Echoes lost: 5 drops (no route to 224.0.0.1 x5)

h1# ping 10.0.0.0
...
% Echoes lost: 5 drops (no ARP reply from 10.0.0.0 x5)
```

`h1# ping 10.0.0.2` in the same lab answers `!!!!!` / `Success rate is 100 percent (5/5)`, so the hosts are up and the
silence above is the console's, not the lab's.

Each of those four failures is a true statement about the code and a false one about the device:

* `_sendIcmp()` (`engine/simulator.js:2949`) asks `routeTo(dstIp)` for a next hop. `255.255.255.255` matches no route in
  the table, so the run is dropped as `no route to 255.255.255.255` - but an all-ones broadcast needs no route, and the
  device would have put it on every attached wire. The sentence teaches a student that the box has no way to send a
  broadcast, which is the opposite of what a real box does.
* `10.0.0.255` and `10.0.0.0` match the connected `10.0.0.0/24` and are then ARPed for like a host, so the reason reads
  `no ARP reply from 10.0.0.255` - the console ARPs for a broadcast address and blames the wire for not answering.
* `224.0.0.1` has no route either, so a group address is reported the same way as an unroutable unicast.

Underneath, `ping()` (`engine/simulator.js:596`) is structurally a one-echo/one-reply exchange: it sends one echo per
sequence, then picks **the first** `icmpReplies` entry matching `(dst, id, seq)` and stores one object per sequence.
`_pingReplyLines()` (`engine/cli.js:4444`) renders that array as one character per sequence and one rate. There is no
place in the model to put three answers to one request, which is why a wording fix is not available here. The L2 half
already exists - `_forwardL2()` floods to `ff:ff:ff:ff:ff:ff` for ARP and DHCP exactly as it would need to for an echo -
so the missing piece is the ICMP/report layer, not the switching layer.

There is also no IP-level notion of "broadcast address" anywhere in the engine: `net.isBroadcastMac()` is a MAC test,
and the IPv4 broadcast of a connected subnet is never computed.

## What is unresolved

1. **A broadcast ping nobody answers.** Every paste in hand has responders. Does the box print `.....` then
   `Success rate is 0 percent (0/5)`, does it print nothing after the send line, or does it print the reply form with an
   empty list? This is the case a lab needs most - "is anything alive on this wire?" - and it is the reason no engine
   change was made on this evidence.
2. **Whether any release prints the success rate after a reply block.** One prompt-visible paste says no; a release that
   does would change the shape.
3. **Whether the box's own interface address appears** in the responder list. It never does in these pastes, though the
   box answers a ping to its own address normally - so either it excludes itself from a broadcast echo or the pastes
   were trimmed.
4. **What the millisecond field does at zero.** All samples are integers >= 2 ms; a lab that computes 0.1 ms needs a
   decision (`<1 ms`? `0 ms`?) and no capture settles it.
5. **How many echoes go out for `255.255.255.255`** - one per interface, or one frame flooded - and whether the request
   counter advances once per interface or once per run. The two-LAN paste shows one list per request, not per interface.
6. **IPv6.** `ping ff02::1` needs a zone on most hosts; whether IOS demands `interface`/`source` first, and whether the
   report uses the same reply form, is not in any source read here.
7. **Whether an L2-only switch with an SVI, or a PC in the lab, behaves like the router** in the pastes. The lab has
   `generic-pc` hosts, and a PC's answer to a broadcast echo is a different OS's decision.
8. **Who actually answered the remote directed-broadcast ping** (item 7 of "known"). The poster says the far router
   replied and did not forward, but a router answering an echo addressed to a subnet broadcast is odd enough to want a
   second capture before it is modelled - and it is the only place where the ordinary marks line survives.

## What evidence would settle it

1. One paste of a broadcast ping into a **subnet with nothing on it**, prompt visible - settles (1) and probably (2).
2. The same run with `show ip traffic` before and after on the sending box - says whether the request counter moved once
   or once per interface, and whether the box counted its own answer (3, 5).
3. One `ping 255.255.255.255` from a box with **two** interfaces and a responder behind only one of them, with the reply
   list printed in full - settles (5).
4. An IPv6 `ping ff02::1` from a router, both bare and with `interface Gi0/0` - settles (6).
5. A capture on the wire (`debug ip packet` or a SPAN port) of a broadcast echo, to see whether the frame is one
   broadcast per interface with the destination left at `255.255.255.255` or rewritten, which is what item 7's poster
   claims IOS does ("The IOS converts it to a 255.255.255.255").

## Smallest honest increment if the evidence lands

Three changes, in one commit, once (1) and (2) are settled:

* **`Simulator.ping()`** learns a broadcast mode: before `routeTo()`, ask whether the target is `255.255.255.255`, a
  connected subnet's all-ones or all-zeros address, or a group address; if it is, put one echo per request on the
  broadcast MAC of every matching interface through the existing flood path, and collect **all** replies for that
  sequence in arrival order instead of the first.
* **`_pingReplyLines()`** prints `Reply to request <n> from <addr>, <ms> ms` for each reply of each request when the run
  was a broadcast, and prints neither the marks line nor the rate - with the unanswered-broadcast case spelled the way
  the capture in (1) spells it.
* **the lost-echo sentence** stops saying `no ARP reply from 10.0.0.255` about an address the box never should have
  ARPed for; a broadcast that nobody answers is not an ARP failure.

The regression test would pin the four-line success run, the multi-responder list in arrival order, the absence of the
marks line and of the rate, and the remote-subnet case keeping `!!!!!` - which is the one behaviour the current engine
already gets right, and the one a careless fix would break.
