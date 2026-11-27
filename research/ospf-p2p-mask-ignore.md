# A point-to-point OSPF link does not compare subnet masks

**Question (one, narrow).** Two routers on a serial link address it with different masks - /24 on one end,
/30 on the other. Does the adjacency form, does the far prefix get installed, and what does the box check
instead?

**Verdict: the adjacency forms, `FULL/ -`, and routes cross.** The Hello's Network Mask is *ignored* on a
point-to-point network, so the two masks never meet; what still has to hold is reachability - each end must
see the other's address inside its own interface network. PacketForge compared the masks on every link, so
the /24-against-/30 pair formed no adjacency, and because the refusal was never recorded the console blamed
the far end for not running OSPF. Both rules are now the engine's: the mask check is skipped for a
point-to-point pair, the per-direction reachability check replaces it, and a refusal on either kind of link
is recorded so `show ip ospf neighbor` can name the field that disagreed.

## What the standard says

RFC 2328 10.5, "Receiving Hello Packets":

> Next, the values of the Network Mask, HelloInterval, and RouterDeadInterval fields in the received Hello
> packet must be checked against the values configured for the receiving interface. Any mismatch causes
> processing to stop and the packet to be dropped. ... **However, there is one exception to the above rule:
> on point-to-point networks and on virtual links, the Network Mask in the received Hello Packet should be
> ignored.**

<https://www.rfc-editor.org/rfc/rfc2328.html#section-10.5>

The mechanism is in the packet format: A.3.2 defines the Network Mask field as "0 if the network is
unnumbered or the interface is a point-to-point interface", so on a point-to-point link the field carries no
mask to compare in the first place.

## What a Cisco box does

1. **A live capture with the exact mismatch.** ipSpace.net, "OSPF Ignores Subnet Mask Mismatch on
   Point-to-Point Links" (Ivan Pepelnjak, 2008) - "Cisco conforms strictly to the RFC and allows OSPF
   neighbors to form adjacency over a point-to-point link ... even when the subnet masks do not match. The
   routers in my lab happily formed the OSPF adjacency even though I have used a /24 mask on one end of the
   link and a /30 mask on the other end."
   <https://blog.ipspace.net/2008/10/ospf-ignores-subnet-mask-mismatch-on.html>

2. **The rule stated for an operator.** Cisco Community, "OSPF & Point-to-Point links" (Peter Paluch):
   "On point-to-point links, OSPF will ignore the subnet mask mismatch. However, the neighbors still have to
   be on a common subnet, i.e. from the viewpoint of one router, the second router's IP address must fall
   within the interface network of the first router."
   <https://community.cisco.com/t5/routing/ospf-point-to-point-links/m-p/1913398>

3. **The vendor's own TAC page separates the two checks.** Cisco, "Troubleshoot Open Shortest Path First
   Route Database Issues" (doc 7112), Reason 3: two point-to-point ends in *different major nets* "still form
   neighbors in Cisco IOS version earlier than 12.1 because on a point-to-point link, OSPF routers do not
   verify that the neighboring router is on the same subnet", and its 12.1+ story is the database
   discrepancy that follows. So the *mask* is not compared, while the peer's address is still expected to be
   inside the receiving interface's network.
   <https://www.cisco.com/c/en/us/support/docs/ip/open-shortest-path-first-ospf/7112-26.html>

## What PacketForge did, and what it does now

`Simulator.computeOspf()` compared the two masks on every link and dropped the link silently:

```js
if (String(ai.mask) !== String(bi.mask)) continue;
if (net.networkOf(ai.ip, ai.mask) !== net.networkOf(bi.ip, bi.mask)) continue;
```

On a serial pair (`Se0/0/0` /24 against /30) that meant no neighbour at all, no `O` route across the link,
and a console sentence that sent the operator to the wrong end of the cable:

```
% no adjacencies: nothing on the other end of an OSPF interface is running OSPF
```

Now:

* The pair's network type is read before the addressing checks (`isSerialPort()` on either end, the same
  predicate the DR election already used).
* On a **broadcast** segment the two checks stay - the mask is a field that segment genuinely compares - and
  a drop is recorded as `reason: 'mask'` or `reason: 'subnet'`.
* On a **point-to-point** link the mask comparison is skipped, and each direction is checked separately:
  the peer's address must fall inside this port's interface network, and this port's address inside the
  peer's. A /24 against a /30 passes both ways (the /30 lies inside the /24, and 10.9.0.2 lies inside
  10.9.0.0/30); two genuinely different subnets fail, and are recorded as `reason: 'subnet'`.
* Both records are mirrored - each box keeps its own port, its own address and mask, and the far end's - so
  the console can print the pair instead of a verdict.

```
r2#show ip ospf neighbor
Neighbor ID     Pri   State           Dead Time   Address         Interface
1.1.1.1           1   FULL/ -         00:00:40    10.9.0.1        Serial0/0/0

r1#show ip route
O   10.9.0.0/30 [110/128] via 10.9.0.2, Serial0/0/0
```

Regression proof: `test/ospf-p2p-mask-mismatch.test.js` (28 assertions) - the adjacency and its `FULL/ -`
state on both ends, the far prefix installed with a reachable next hop, a ping across the mismatched link,
the out-of-network peer still refused (and recorded), the broadcast refusal naming both prefixes, and the
already-correct equal-mask cases on both media.

## Inferred, and unresolved

* **Inferred:** that the reachability check is per direction with each end's own mask rather than a single
  shared-subnet comparison. Paluch states it that way; no capture in hand prints the refusal a modern box
  gives for an out-of-network peer, so the console's sentence for it (`the address of a neighbour has to
  fall inside the network of this interface`) is this console's wording, not the vendor's.
* **`ip ospf network point-to-point` is not modelled.** On Ethernet converted with that command a mask
  mismatch also forms an adjacency; this console decides point-to-point from the port hardware alone, so
  such a link still refuses. What would settle it: the command itself (a per-port OSPF network type), which
  is a missing feature rather than a fidelity correction.
* **Unnumbered links are not modelled.** With `ip unnumbered` both the mask and the subnet checks are
  skipped (Paluch, again) and the Hello carries 0.0.0.0. No port here can be unnumbered, so nothing was
  changed for it.
* **The log line.** A real box records the broadcast mismatch in `debug ip ospf hello` as `Mismatched hello
  parameters`; this console has no OSPF log, and the sentence in `show ip ospf neighbor` is the only place
  the fact appears.
