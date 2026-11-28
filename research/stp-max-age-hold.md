# How long a bridge keeps believing the root after the BPDUs stop

Question: a bridge is not the root. The cable that breaks is somewhere else, so this box's own ports stay
up and merely stop receiving configuration BPDUs. How long does it keep acting on the last one, and what
does it run when it finally gives up? The companion note
[stp-root-timers-pace-the-tree.md](stp-root-timers-pace-the-tree.md) settles *whose* timers a non-root
runs while it is one; this note is about the window at the end of that.

## What the sources say

1. **IEEE 802.1D-2004, 17.9 "Changing spanning tree information"**: "To ensure that old information does
   not endlessly circulate through redundant paths in the network and prevent propagation of new
   information, each Configuration Message includes a message age and a maximum age. The message age is
   incremented on receipt, and the information discarded if it exceeds the maximum." So the stored BPDU
   has a lifetime, it is refreshed by each hello, and when the refresh stops the information goes stale on
   a timer rather than at once. The same clause is where every vendor description of the 20-second wait
   comes from.

2. **Cisco, "Understand and Configure Backbone Fast on Catalyst Switches" (doc 12014)** walks one indirect
   failure through to the end, and gives both halves of the arithmetic:
   "After max_age timer expires (20 seconds by default), the BPDU stored on S for port P ages out ...
   Port P moves to the forwarding state through listening and learning states. This takes twice the
   fw_delay value, an additional 30 seconds ... It took the max_age value (20 seconds) plus twice the
   fw_delay value (2x15 seconds) to recover from this indirect link failure. **This is 50 seconds with the
   default parameters.**" The feature the note is about exists only to skip that first term, and the note
   is explicit that it "only works if a bridge detects a **direct** link failure" - which is the other
   half of the rule: a local port going down does not wait.
   <https://www.cisco.com/c/en/us/support/docs/lan-switching/spanning-tree-protocol/12014-18.pdf>

3. **Cisco Learning Network, "STP questions"** - the same 30 vs 50 split, and the refinement:
   "direct failure: 30 sec (15 sec listening + 15 sec learning); indirect failure: 50 sec (20 sec max age
   time + 30 sec listening and learning)... The actual time in case of indirect link failure is
   **(Max age)-(message age)** + listening + learning, so in fact it is slightly under 50 seconds."
   <https://learningnetwork.cisco.com/s/question/0D53i00000Kt5jMCAR/stp-questions>

4. **Cisco Learning Network, "STP timers" / "CCNA STP-Convergence and re-Convergence"** - why the
   information cannot simply be replaced by a better BPDU on another port while it is still live: "the
   stored BPDU on that port will live for up to 20 seconds. With indirect failures ... the MaxAge of the
   BPDU has to expire before it starts to believe new information."
   <https://learningnetwork.cisco.com/s/question/0D53i00000Kt0MQCAZ/ccna-stpconvergence-and-reconvergence-do-you-agree>

## What this model now does

`engine/convergence.js` gained one function, `stpMaxAgeHold(topo, dev, opts)`, and the STP entry in
`buildSchedule()` adds its answer in front of the forward-delay wait:

```
readyAtMs = holdMs + timersInForce.forwardAtMs
```

The hold is non-zero only when **all** of these hold, each of them read off the election from *before* the
change (`opts.stpBefore`):

- the box was not the root;
- it had a finite cost to the root, i.e. it was actually hearing a BPDU;
- neither end of the cable that moved is this box (its own port did not go down - that is the direct case,
  and 802.1D discards a port's information when the port goes down);
- after the change it is either not hearing that root any more, or hearing a different one.

When it fires, the wait is the **old root's** Max Age - the timers that were in force - and the transition
that follows runs on the box's **own** forward delay, because by then it is the root of what is left. Cisco
Learning Network's "slightly under 50 s" is the message-age subtraction; this model does not have per-hop
message ages, so it uses the full Max Age and says so in the schedule's `basis` string.

`Simulator.setLinkState()` now records the pre-change election with the change (`_lastLinkChange`), and
`getConvergence()` passes it to the schedule only for the instant that change produced.
`markTopologyChange()` - a local `shutdown`, a direct failure at the box that typed it - clears the record
rather than reusing it.

`test/stp-max-age-hold.test.js` (28 assertions) pins: a 4 s / 10 s root makes an indirectly isolated box
wait 10 s + 2 x 15 s = 50 s while a directly failed neighbour still converges in 30 s; the wait is the old
root's Max Age, not the isolated box's own 40 s, and its own 4 s forward delay is what paces the transition
that follows (18 s); a triangle that reroutes around the cut pays nothing; a converged board and a repaired
cable carry no hold; a second, direct change is not credited with the first change's history; and the
console's "Network converges again at N ms" is the schedule's own number (50 000 for the indirect cut).

## What is inferred, not sourced

- **Mapping "the cable that moved is not mine" to "indirect"**. No source describes a simulator's graph
  edit; the inference is that a box with no port on the failed link, which loses its root over that link,
  is exactly the box the 20-second wait is about. It is the definition of an indirect failure in every
  source above, but it is a mapping this model chose.
- **"Still hearing the root" means no wait.** The Learning Network note says the stored information has to
  expire before the box believes *new* information; a triangle whose third leg still carries the root's
  BPDUs is therefore the supersede case (802.1D 17.9's "new information will propagate rapidly"), not the
  expiry case. This is why the triangle in the test pays nothing.
- **Which timers are in force after the transition.** Once a box claims the root role it advertises its own
  parameters, so its own forward delay paces the ports that come up. That follows from the companion note's
  rule rather than from a capture of this exact transition.

## What remains unresolved

- **Message age is not modelled.** A box one hop below the root should wait 19 s, not 20; two hops, 18 s.
  There is no per-hop message age here, so the hold is always the full Max Age. A `debug spanning-tree
  events` capture on a three-hop lab with the timers printed on both sides would settle whether the model
  should charge hops.
- **The hold is invisible while it runs.** Nothing in `show spanning-tree` says "waiting for the BPDU to
  age out"; the port table prints the post-change roles from the moment the cable moved, so the box looks
  converged for 20 s that it is not. A real capture shows the old roles still in the table during that
  window (the port is still Root/Forwarding until the information expires).
- **Hello counting is still inert.** Losing every other hello, or a one-way path, is not distinguishable
  from silence.
- **Two cables pulled at the same instant.** `_lastLinkChange` keeps the last one, so `touched` names one
  cable's endpoints. A second simultaneous change would have to be merged to be read correctly.
- **A fresh `Simulator` on the same board forgets the election.** `topo.markChange()` survives, the
  pre-change election lives on the simulator, so a request handled by a new simulator sees the change
  instant but not the BPDUs that preceded it and the hold is dropped. Keeping it on the topology, the way
  DHCP leases are kept (#1429), would fix that; it is not done here.
- **MSTP / RSTP.** RSTP's proposal/agreement handshake replaces both this wait and the listening/learning
  pair on point-to-point links; none of this applies to it.
