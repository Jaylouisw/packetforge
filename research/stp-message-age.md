# The subtraction in "Max Age less message age"

Question: a bridge that loses its root without losing a port keeps the last configuration BPDU until it
ages out. How long is that, on a bridge in the middle of a tree rather than next to the root? The companion
notes [stp-max-age-hold.md](stp-max-age-hold.md) settle *that* there is a wait at all and
[stp-root-timers-pace-the-tree.md](stp-root-timers-pace-the-tree.md) settle *whose* timers run during it.
This note is about the number at the front of the sum: not 20 s, but 20 s less the age of the message the
box is holding.

## What the sources say

1. **Cisco, "Understand and Tune Spanning Tree Protocol Timers" (doc 19120)** states the field and then the
   arithmetic with the first three rungs worked out:

   > "The root bridge sends all its BPDUs with a message age value of 0, and all subsequent switches add 1
   > to this value."
   >
   > "When a new configuration BPDU is received that is equal to or better than the recorded information on
   > the port, all the BPDU information is stored. The age timer begins to run. **The age timer starts at the
   > message age that is received in that configuration BPDU.** If this age timer reaches max age before
   > another BPDU is received that refreshes the timer, the information is aged out for that port."
   >
   > - "Switches B and C receive a configuration BPDU from switch A with a message age of 0. On the port that
   >   goes to A, the information ages out in (max age - 0) seconds. This time is 20 seconds by default."
   > - "Switches D and E receive the BPDU from switch B with a message age of 1. On the port that goes to B,
   >   the information ages out in (max age - 1) seconds. This time is 19 seconds by default."
   > - "Switch F receives the BPDU from switch E with a message age of 2. On the port that goes to E, the
   >   information ages out in (max age - 2) seconds. This time is 18 seconds by default."

   The same document names the per-hop increment as an over-estimate that every bridge applies:
   "message age increment overestimate (msg_overestimate) - this value is the increment that each bridge
   adds to the message age before it forwards a BPDU ... Cisco switches (and probably all switches) add 1
   second to the message age before the switches forward a BPDU."
   <https://www.cisco.com/c/en/us/support/docs/lan-switching/spanning-tree-protocol/19120-122.html>

2. **Huawei, "STP/RSTP/MSTP Timers"** (Enterprise configuration guide, Ethernet Switching) gives the same
   rule and the discard that follows from it: "after a non-root bridge receives a configuration BPDU, it
   compares the Message Age value with the Max Age value before deciding whether to forward or discard ...
   In real-world situations, the Message Age value of a configuration BPDU is incremented by 1 each time the
   configuration BPDU passes through a bridge." Its worked example is the same ladder: neighbours of the
   root see 0, the next ring 1, the ring after 2.
   <https://support.huawei.com/enterprise/en/doc/EDOC1100458999/98dc381e/stp-rstp-mstp-timers>

3. **howtonetwork, "802.1D Spanning Tree Protocol - Spanning Tree Timers"** tabulates the subtraction per
   switch: "To determine the time before information received on that port is aged out, the switch subtracts
   the Message Age from the Max Age", with a table showing Switches 1 and 2 at message age 0 / 20 s,
   Switches 3 and 4 at 1 / 19 s, Switch 5 at 2 / 18 s.
   <https://www.howtonetwork.org/switch/module-3/802-1d-spanning-tree-protocol-spanning-tree-timers/>

4. **UNH-IOL RSTP conformance suite** corroborates the increment from the test side: "Message Age held by
   the Root Port, incremented by 1 second and rounded to the nearest whole second", and a validation case
   that requires the DUT not to process a BPDU whose message age is at or past Max Age.
   <https://www.iol.unh.edu/sites/default/files/testsuites/bfc/rstp_D.op.test.suite.pdf>

The Cisco Learning Network shorthand quoted in the companion note - "(Max age)-(message age) + listening +
learning ... slightly under 50 seconds" - is this same arithmetic stated by an operator rather than a
manual, and it was the loose end left by #1746.

## What is inferred, and how firmly

- **One second per bridge, not per unit of cost.** Every source says "adds 1", none says it depends on the
  link. The engine's `cost` is the short path-cost method (19 for 100 Mb, 4 for 1 Gb, 2 for 10 Gb), so a
  hop count had to be a separate field on the election rather than a division of `cost`. Firm.
- **The count is bridges between the box and the root, along the active tree.** That is what the root port
  chain is, and it is what both vendor ladders draw. Firm.
- **The increment is applied before forwarding, so the value a bridge stores is one less than its own
  distance.** Cisco's ladder settles this: the neighbours of the root hold message age 0, so a box one hop
  out stores 0 and a box two hops out stores 1. Firm, and the reason the ladder starts at 20 s and not 19 s.
- **A bridge whose stored BPDU is already at Max Age has nothing to wait for.** Huawei states the discard;
  the arithmetic gives a zero or negative hold. The engine clamps to zero. Firm as arithmetic, thin as
  modelled behaviour: it does not go on to block the port that delivered the BPDU, which is what the
  discard rule implies on the wire.
- **The real transmission delay is not added.** A BPDU spends time on the wire and in each bridge's queue;
  the 1 s increment is an over-estimate that is meant to cover it. The model therefore takes the vendor's
  over-estimate as the whole age. Consistent with the vendors' own arithmetic, which uses the same numbers.

## What changed in the engine

`runStp()` now reports `hops` per bridge (0 at the root, null when the root port chain cannot be resolved,
e.g. a zero-cost port that makes the parent no cheaper than the child). `stpMaxAgeHoldInfo()` in
`engine/convergence.js` subtracts `hops - 1` from the Max Age that was in force, clamps at zero, and the
schedule entry carries `messageAgeSec` and a `basis` that spells the subtraction out ("19 s = 20 s Max Age
less message age 1"). `stpMaxAgeHold()` keeps its number return for callers that only want the wait.
Regression: `test/stp-message-age.test.js`, which walks a five-bridge chain and checks the doc-19120 ladder
(19/18/17 s) plus the clamp and the unknown-hops fallback; `test/stp-max-age-hold.test.js` was corrected by
one second, since its far box sits two bridges out.

## What remains unresolved

- **The age is not on the wire, so it is not in the report.** `show spanning-tree` does not print a message
  age, and neither does this console; the subtraction is visible only in the schedule's `basis`. A capture of
  `debug spanning-tree events` on a partitioned non-root would settle whether an operator ever sees this
  number, and in what words.
- **Per-port stores are not modelled.** A bridge holds one BPDU per port, and the ones on blocked ports have
  their own ages; only the root port's store is used here, which is the one that decides whether the box
  still believes in the root.
- **Hop count through an aggregator or a zero-cost link.** The field goes null in that case and the model
  falls back to the whole Max Age; a real box would still count the bridge. A lab with a port-channel and a
  `cost 0` port would settle it.
- **RSTP counts hops, not seconds.** 802.1w replaces the aging timer with a hop count against a 20-hop
  budget; this engine models 802.1D only, and says so.
