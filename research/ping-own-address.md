# Can a box ping an address it holds?

**Question (one, narrow).** When a router or host sends an ICMP echo to an address configured on one of its own
interfaces, is the request put on the wire and answered by the far end of a cable, or is it delivered locally and
answered by the box's own IP stack?

**Verdict: settled by the standards, and the console was wrong.** A packet whose destination exactly matches one of
the box's own addresses is *delivered locally* and is not transmitted at all; the box's ICMP echo server then answers
it. PacketForge put the request on the wire, ARP'd for its own address and reported the silence as
`% Echoes lost: 5 drops (no ARP reply from 10.0.0.1 x5)` - a drop blamed on the very box the operator was sitting at.

## What PacketForge did before this change

```
r1(config)# interface Gi0/0
r1(config-if)# ip address 10.0.0.1 255.255.255.0
r1(config-if)# end
r1# ping 10.0.0.1
Type escape sequence to abort.
Sending 5, 100-byte ICMP Echos to 10.0.0.1, timeout is 2 seconds:
.....
Success rate is 0 percent (0/5)
Request timed out (seq 0)
...
% Echoes lost: 5 drops (no ARP reply from 10.0.0.1 x5)
```

Every device in the lab had the same hole: a PC could not ping its own address either, and no device could ping the
address it answers BGP with or the address on its second port.

## Evidence

| Source | Says |
| --- | --- |
| [RFC 1812 §5.2.3, Local Delivery Decision](https://www.rfc-editor.org/rfc/rfc1812.txt) | "The packet is delivered locally and not considered for forwarding in the following cases: - The packet's destination address exactly matches one of the router's IP addresses". Local delivery is the rule; forwarding is the exception. |
| [RFC 1812 §4.3.3.6, Echo Request/Reply](https://www.rfc-editor.org/rfc/rfc1812.txt) | "A router MUST implement an ICMP Echo server function that receives Echo Requests sent to the router, and sends corresponding Echo Replies." An echo to the router's own address is an echo sent to the router. |
| [RFC 1122 §3.2.2.6, Echo Request/Reply](https://www.rfc-editor.org/rfc/rfc1122.txt) | "Every host MUST implement an ICMP Echo server function that receives Echo Requests and sends corresponding Echo Replies." The same duty on the host side, which is why a PC must answer its own address too. Only *broadcast* and *multicast* echoes may be silently discarded - an own-address echo is neither. |
| [RFC 792, Echo or Echo Reply Message](https://www.rfc-editor.org/rfc/rfc792.txt) | The echoer sends an ICMP Echo to the address specified and the receiver returns the data. Nothing in the message format distinguishes a local receiver from a remote one. |
| [RFC 826, An Ethernet Address Resolution Protocol](https://www.rfc-editor.org/rfc/rfc826.txt) | ARP resolves an address to a link-layer address on a shared medium. A stack that has already decided a datagram is for itself never asks the medium - which is why the old output's `no ARP reply from 10.0.0.1` could not have happened on a real box: nothing on the segment would have been asked. |

No vendor transcript was needed, and none was found that prints the local echo's round trip: the decision is taken
before any vendor CLI is involved, by the IP layer both standards describe. The round-trip figure the box prints for
such a ping is therefore a local implementation detail (IOS reports its own timer granularity, typically `1 ms`); this
model reports the honest `0.000 ms`, because the echo crosses no link and the latency model has nothing to add.

## What is now implemented

* `Simulator._sendIcmp()` asks `Device.holdsIp()` before it looks for a route. An address the device holds on an
  enabled interface is answered by the device itself: the run records an `icmp-echo`, the reply lands as an
  `icmp-received`, and no frame - and so no ARP request - is built.
* `Simulator._sendIcmp6()` asks `Device.interfaceWithIp6()` for the same reason, so a configured IPv6 address and the
  EUI-64 link-local every port forms for itself are answered off the wire as well.
* The round trip comes out of the run's own event list, which holds no frame for this exchange: `ping 10.0.0.1` from
  the box that owns it prints `Success rate is 100 percent (5/5), round-trip min/avg/max = 0.000/0.000/0.000 ms`.
* `traceroute <own address>` becomes one hop, which is what a trace to yourself is.
* `holdsIp()` only answers for an *enabled* interface, so an address on an administratively disabled port still takes
  the routing path and fails there - the box does not answer for a port it has taken out of service.
* Everything else is unchanged: a neighbour that holds nothing is still unanswered (`no ARP reply from 10.0.0.99`),
  and a host still reaches the router across the wire.

`test/ping-own-address.test.js` holds the local echo (IPv4 and IPv6, console and engine API), the unchanged wire
behaviour, and the one-hop trace.

## What remains unresolved (and why nothing was changed for it)

* **TCP and UDP to your own address.** `Simulator._sendTransport()` still routes a SYN to the wire, so a device cannot
  open a flow to a service it hosts itself (a DNS query to its own resolver, say). The same local-delivery rule
  applies, but the flow engine, the DNS resolver and the ACL/NAT hooks on that path each need the answer, and a
  half-applied version would be worse than the current gap.
* **A VIP.** A VRRP virtual address is not an address the box *holds* (`holdsIp()` answers for configured interface
  addresses only), so an echo to the VIP from the master itself still goes to the wire and is answered there, by the
  group. Whether a real master answers its own VIP locally is a separate question and is not settled here.
* **Counters.** A local echo moves no interface counters, which is correct for a packet no port transmitted, but it
  means `show interfaces` no longer accounts for every echo a `ping` claims to have sent. That asymmetry is the
  honest one; the alternative - counting a packet that was never built - is the lie.
