# Two equal-cost paths to the root: which port does the bridge elect?

**Question (one, narrow).** When a non-root bridge has two links to the root that cost the same, what decides
which of them becomes its root port — and what did PacketForge decide?

**Verdict: known, and adopted.** 802.1D compares the received BPDUs as an ordered vector, and the **sender's**
port ID is one of the fields — before the receiving port. PacketForge compared the cost and the sender bridge
ID, then jumped straight to the *local* port name **as a string**, so it (a) ignored the field that decides
between two links to the same neighbour and (b) ordered `Fa0/10` ahead of `Fa0/9`. On a two-link lab that made
the tree block the link a real box forwards on. `engine/stp.js` now compares the sender port ID and the
receiving port ID as numbers, and `test/stp-root-port-tiebreak.test.js` holds it (19 checks).

## The vendor's own statement of the order

Cisco, *Information about Multiple Spanning Tree Protocol* (IOS XR, Cisco 8000), "STP protocol operation":

> The root port is selected based on the lowest root path cost to the root bridge. If there is a tie in root
> path cost, the local switch selects the port that receives the BPDU with the lowest sender bridge ID as the
> root port.
>
> […] Where two paths from a given LAN segment have an equal cost, the selection is further determined by the
> lowest bridge ID of the attached devices, and in the case of two attachments to the same device, by the
> configured port priority and port ID of the **neighboring attached ports**.

* https://www.cisco.com/c/en/us/td/docs/iosxr/cisco8000/l2vpn/l2vpn-config-cisco8000/multiple-spanning-tree-protocol-w/information-about-multiple-spanning-tree-protocol.html

Two things follow that the old chain had no rule for. First, the tie-break after the cost is the **sender's**
bridge ID and port ID — the BPDU, not the local socket. Second, the sentence names "two attachments to the same
device" explicitly, which is exactly the parallel-link case: the two local ports are interchangeable and only
the neighbour's port IDs differ.

The Catalyst 3850 configuration guide lists the same order as a sequence for the root port — lowest root bridge
ID, lowest path cost, lowest designated bridge ID, lowest designated path cost, lowest port ID — and adds the
sentence that a tie at the end is settled by the lowest-numbered port:

> If all interfaces have the same priority value, spanning tree puts the interface with the lowest interface
> number in the forwarding state and blocks the other interfaces.

* https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst3850/software/release/16-12/configuration_guide/lyr2/b_1612_lyr2_3850_cg/configuring_spanning___tree_protocol.pdf

The "lowest-numbered port" wording is the reason the local comparison has to be numeric. `Fa0/10` is a higher
port number than `Fa0/9`; a string comparison says the opposite, and that is the comparison this file used.

Cisco's older *Understand and Configure Backbone Fast* page states the same partial order for BPDU comparison —
root bridge ID, then path cost, then sender bridge ID, with "other variables that then can act as a
tie-breaker":

* https://www.cisco.com/c/en/us/support/docs/lan-switching/spanning-tree-protocol/12014-18.html

The full vector in IEEE 802.1D-2004 §17.6 is RootID, RootPathCost, DesignatedBridgeID, DesignatedPortID,
BridgePortID, in that order. The standard itself was not fetched for this note; the three Cisco pages above
state the same order, the last two fields in the vendor's words ("port priority and port ID of the neighboring
attached ports", then "the lowest port ID").

## What was wrong, demonstrated

Two equal-cost links, root `sw1` (priority 4096), two `Fa` ports on each side, cable crossed so the sender and
the receiver disagree:

```
sw1 Fa0/9  --- sw2 Fa0/2      sender port ID 9  -> the better BPDU
sw1 Fa0/10 --- sw2 Fa0/1      sender port ID 10
```

`runStp()` before the change, on that graph:

```
sw2: {"Fa0/1":{"role":"root",...}, "Fa0/2":{"role":"alternate","state":"blocking",...}}
```

and after:

```
sw2: {"Fa0/1":{"role":"alternate","state":"blocking",...}, "Fa0/2":{"role":"root","state":"forwarding",...}}
```

The old answer is wrong twice over: it rooted through the link whose BPDU is *worse*, and it would have chosen
that link even if only the local names had been compared (`'Fa0/1' < 'Fa0/2'` is true, but the local comparison
is the *last* term and only reached when the BPDUs are identical).

Observable in the console, which is what `test/stp-root-port-tiebreak.test.js` asserts end to end — two
`generic-switch` boxes, crossed cables, `show spanning-tree` on the non-root:

```
Port          Role          State
Fa0/1         alternate     blocking   (traffic dropped)
Fa0/2         root          forwarding
```

## What changed

`engine/stp.js`:

* `portIdParts()` / `comparePortIds()` — a port ID comparison that splits a name into digit and text runs and
  compares the digit runs as numbers, in order, so `Fa0/9 < Fa0/10` and `Gi1/0/10 < Gi2/0/1` (module before
  port, the order an ifIndex follows). A comparison of only the *last* number in the name would put `Gi2/0/1`
  ahead of `Gi1/0/10`.
* The root-port loop now walks the vector in order: cost, then sender bridge ID, then **sender** port ID, then
  the receiving port ID. The last two are the new terms.

## What is inferred, and what would settle it

* **Port priority is assumed equal on every port** (the 128 default). `spanning-tree port-priority` is not
  modelled, so the priority byte is identical on both sides of every comparison here and only the number
  decides. A device that sets a per-port priority would break this. To settle: a `show spanning-tree detail`
  transcript from a box with two different port priorities on two equal-cost links.
* **The port number is read out of the catalogue's port name**, because PacketForge has no ifIndex. Within one
  port type the ordering is the panel's, which is the box's. Across two port types on equal-cost links
  (`Fa0/2` vs `Gi1/0/1`) the comparison falls back to the type word, and the real box's answer depends on an
  ifIndex allocation Cisco does not publish. To settle: BPDU captures from a box whose equal-cost links are on
  different port types.
* **Not modelled at all:** the designated-port tie-break's own "lowest-numbered port on the local switch"
  clause. `segmentWinner()` resolves a segment by root cost and bridge ID, which is what decides a segment
  between two bridges; the local-port clause is only reachable when one bridge offers two candidates for one
  segment, which the graph builder (one logical port per segment) cannot produce.
* **The sender bridge ID still outranks the sender port ID**, as the vendor's sentences put it. No graph can
  reach a case where the two disagree (equal-cost paths to two different neighbours with the same bridge ID),
  so that half of the order is asserted only by construction, not by a test.
