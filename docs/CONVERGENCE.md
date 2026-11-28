# Convergence

A lab that only shows the converged answer teaches half of network engineering. The other half is
the interval between *power on* and *working*, where the link lights are green and nothing passes.

```
SW1#converge
Process   Device                 Ready     Basis
stp       SW1                    30000 ms  listening + learning (15 s forward-delay each)

Fully converged at 30000 ms.
```

The `Device` column is as wide as the longest name in the answer, so a device nobody renamed - the default name is the catalogue label plus the id - widens the column instead of running into the instant beside it.

```
SW1#ping 10.0.0.2 1 at 5000
Type escape sequence to abort.
Sending 1, 100-byte ICMP Echos to 10.0.0.2, timeout is 2 seconds:  (at t=5000 ms)
.
Success rate is 0 percent (0/1)
% Still converging: stp on SW1 (ready at 30000 ms) at t=5000 ms
```

Note what that last line is not: it is not `Request timed out`. Nothing was lost. The network was
not up yet, and the engine says which process is not finished and when it will be. The sentence is written once
(`pingConvergenceSentence()` in `engine/simulator.js`), printed once however many echoes were held up, and mirrored
by the browser's Simulate dialog so the two surfaces cannot describe the same answer differently.

The instant printed at the end is the one the **answer** belongs to (`res.runAtMs`), not the one you typed: a ping
with no `at` is asked at `Infinity`, and says nothing about convergence at all.

`at <ms>` applies to that one command. `setRunTime()` persists on the simulator, so the console used to leave the
whole session answering at the instant you last named — the next plain `ping`, a later `show ip route`, anything.
The console now restores the instant it arrived with, whatever the ping did.

## The rule

`Simulator.setRunTime(ms)` sets the instant a question is asked at.

| Value | Meaning |
|---|---|
| `Infinity` (default) | Fully converged. Every existing lab and test behaves exactly as before. |
| finite | Only the processes that have finished by then have taken effect. |

`ping ... at <ms>` and `converge` drive it from the CLI; `ping(src, dst, { atMs })` from the engine
via `setRunTime()` before the call.

A process that has not finished leaves the device in the state the standard says it is in, rather
than in a special "simulation" state:

- **STP** — a port destined to forward is Listening (0…forward-delay) or Learning (forward-delay…2×).
  It drops traffic in both. A port destined to block is Blocking from t=0, which is what it is.
- **OSPF** — no routes from that adjacency. The topology is up and the neighbour is not, which is
  distinguishable from "no route because none is configured" only by the pending list.
- **VRRP** — the group does not own the VIP until `3 × Advertisement_Interval + Skew_Time`.
- **DHCP** — no lease until the four-message exchange completes.

## The timers

Each has its standard default. Only **one** of the seven can be changed from the console today:
`vrrp <vrid> timers advertise <seconds>` (interface mode) writes the advertisement interval, and `converge`
then reports `3 x advertise 4 s + skew` - 12609.375 ms at the default skew, where the same box at 1 s
reports 3609.375 ms. The rest are read from configuration keys - `stpForwardDelaySec` and
`stpMaxAgeSec` on the device config, `ospf.helloSec`, `ospf.exchangeSec` and `ospf.spfDelaySec` under
`config.ospf`, `dhcpExchangeSec` on the device config - that nothing in `engine/cli.js` writes. A
fixture can set them; a technician cannot. STP is the plainest case: the console's only
spanning-tree tunable is the bridge priority, `spanning-tree forward-delay 4` is refused as an
unknown sub-command whose sentence names `spanning-tree priority <0-61440 in 4096 steps>`, and
`ospf hello 5` answers `% Usage: ospf router-id <ip> | ospf area <id>`. This page used to say every
timer was overridable, which no reader could reproduce at a console; the schedule itself already
prefers configuration over the default (`engine/convergence.js`), so the missing half is the
commands, not the model.

| Process | Default | Source |
|---|---|---|
| STP forward delay | 15 s | 802.1D §17.14 — a forwarding port waits 2× this |
| STP max age | 20 s | 802.1D — how long a bridge holds a root BPDU it can no longer hear before it re-roots |
| OSPF hello | 10 s | RFC 2328 on a broadcast segment |
| OSPF exchange | 1 s | modelled DBD/LSDB synchronisation |
| OSPF SPF delay | 5 s | the hold before the first route lands |
| VRRP advertisement | 1 s | RFC 5798 §6.1 |
| DHCP exchange | 1 s | DISCOVER/OFFER/REQUEST/ACK |

`engine/convergence.js` is pure: it reads configuration and returns times. No clock, no state, no
side effects. The simulator decides what to do with the answer.

## What this does not model

Honestly, and by design:

- **Real-time interleaving.** Nothing runs a clock during a run. A question is answered *as of* an
  instant, computed from the timers. Two processes that would overlap in reality are each either
  finished or not.
- **Timer jitter and retransmission.** A hello is heard, not lost. There is no dead-interval expiry,
  no 3-missed-hellos neighbour teardown, no exponential backoff.
- **Two changes at once.** Only the most recent change is kept (`topology.lastChangeAtMs`), so a
  second cable pulled while the first re-convergence is still running re-bases the whole schedule
  from the newer instant: every port waits its two forward delays from the last change, and the
  earlier deadline is gone rather than interleaved with it.
- **STP port roles changing over time.** Roles come from the steady-state computation; only the
  transitional Listening/Learning state is timed, and the adoption instant below.
- **A staggered power-on is not a console action.** `Device.bootedAtMs` is a runtime field an embedder
  (or a test) can set; nothing in `engine/cli.js` writes it, so every lab typed at a console powers its whole
  board at 0. A `power on at <ms>` verb would be new surface and is not proposed here.

Each of those is a real gap and each is a candidate for its own issue. What exists is the part a
technician meets first: the honest *duration* of coming up.

## Power-on order: when the adoption starts

A bridge does not run its own timers until it has heard the root, and this model used to pretend otherwise: the
root's forward delay paced a non-root's ports from the lab's `t = 0`, so a switch powered on seconds *before* its
root converged on numbers nobody was advertising to it yet. The schedule now dates the window.

A port transmits a configuration BPDU the moment it becomes designated, which at power-on is at once - the box has
no better information and believes itself root. So the root's first BPDU leaves at the root's own boot, and a
bridge powered on together with the root (or before it) accepts it at that instant. A bridge powered on into a
tree that is already running is the other case: it waits out the remainder of the root's hello timer, so one hello
interval is the worst case - and the one number in the adopted set that a real timer prices.

```
SW2#converge
Process   Device                 Ready     Basis
stp       SW1                    8000 ms   listening + learning (4 s forward-delay each)
stp       SW2                    15000 ms  heard the root SW1 at 7000 ms, then listening + learning (4 s forward-delay each, the root SW1's)
```

`SW2` came up at 5 s, heard `SW1`'s next hello at 7 s, and walked the root's two 4 s delays from there - 15 s, not
the 8 s this schedule used to report for a tree that was still being advertised, and not the 30 s its own default
would take. Until 7 s its ports are paced by its own configuration, so `stpPortStateAt()` answers those seconds from
`stpTimers(dev)`: a port can be Listening on a 15 s forward delay while the tree it is joining runs a 4 s one. A box
that has not been powered on yet blocks, which is what a dark port does.

Two simplifications, stated rather than hidden: a port that is already Listening keeps the value it loaded, and this
model reloads it at adoption, so the transition restarts at the instant the root is heard; and the credit is one
hello, not a measurement - a capture of `debug spanning-tree events` on both sides of a power-on would replace the
constant, and the console has no such debug view to take one from. A re-convergence is not charged a hello: a box
that was already hearing the root holds its BPDU, so a cable moving elsewhere in the lab does not restart the
adoption clock, and a box powered on after the change has nothing stored, so it owes no Max Age either.

## Re-convergence: a cable is pulled

Everything above describes a network that is being powered on. The same timers run again whenever
the topology *changes*, and they run from the instant of the change:

```bash
R1#link down l5 at 10000
Link l5 (SW1:Fa0/1 <-> SW2:Fa0/1) is now down.
Network converges again at 40000 ms.
```

Ten seconds plus the two forward delays, because a switch that has to bring a new port into
forwarding walks it through Listening and Learning just as it does at boot. That 40 s is the
**direct** failure: both boxes at the ends of `l5` watched their own port go down, so the stored BPDU
on that port was invalidated on the spot and the two forward delays start at the change. A bridge
elsewhere in the lab that merely *stopped hearing* the root - its own ports still up - is not told
that early. It keeps the old root's configuration BPDU until Max Age runs out and only then claims the
root role and runs its own two forward delays: 20 s + 30 s with the defaults for a bridge one hop out of
the root, so a change at 10 s settles at 60 s, not 40 s. A bridge further out has less left to wait - the
age timer starts at the Message Age in the cached BPDU, which grows by 1 s per bridge, so two hops out it is
19 + 30 s and the `Basis` column reads `19 s = 20 s Max Age less message age 1`. `converge` says which
arithmetic produced the instant there, not just how long; [LINK-STATE.md](LINK-STATE.md) has both rows.

A port's own state is counted from the same instant, not from the absolute clock. Each schedule entry carries
`startedAtMs` (the change) beside `readyAtMs` (the change, plus any Max Age the box waited out, plus two forward
delays), and `stpPortStateAt()` reads the entry: Listening at `startedAtMs`, Learning one forward delay later,
Forwarding at `readyAtMs`. A port the new tree has just unblocked is therefore Listening at the instant the cable
moved - it used to read Forwarding there, 8 s before the reply above said the tree would be whole - and a
partitioned bridge's ports are Blocking for as long as it is still sitting out the old root's Max Age, because
the transition has not begun. The steady-state role still comes from the election; only the seconds are timed.

With no `at`, the change happens at the instant the console is standing at — `link down l5` typed in a session at
60000 ms records the pull at 60000 and reconverges at 90000. It used to be stamped t=0 regardless, so the console
answered "Network converges again at 30000 ms" half a minute *before* the moment it was asked about, while the same
board asked through the API with `atMs` answered 90000. One rule now, at both doors: an instant that is named is
used; an instant that is not named is the instant of the question; a settled board (no instant) starts at 0. An
`atMs` that is not a time at or after 0 is refused (`E_BAD_INSTANT`) instead of quietly becoming zero. Ask inside that window
and the answer is `reason: 'converging'`, naming the processes that are not done; ask after it and
the alternate path is carrying traffic.

`getConvergence()` reports `fromMs` — the instant the schedule is based at — and includes the change
itself as an entry, so nothing in the schedule claims to be ready before the event that caused it.

The change instant lives on the topology (`lastChangeAtMs`) rather than on a `Simulator`, so a lab
reloaded from disk still knows when its cable was cut and still reports the correct window.

Only 802.1D timers are modelled: RSTP's sub-second proposal/agreement is not, so a simulated
re-convergence costs what 802.1D charges - 30 s when a box watched its own port go down, 50 s when it
only stopped hearing the root and owes the old root's Max Age first. See [LINK-STATE.md](LINK-STATE.md).
