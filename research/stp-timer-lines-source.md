# `show spanning-tree`: are the two timer lines the same set of numbers?

**Question (one, narrow).** The Root ID block and the Bridge ID block each end with
`Hello Time <h> sec  Max Age <m> sec  Forward Delay <fd> sec`. Is that one line printed twice - one set of numbers,
this box's - or two different sets? And where does a number come from when a fixture configures it?

**Verdict: two sets, and they can differ on one screen.** The Root ID line carries the **root's** timers: 802.1D's
configuration BPDU carries the root's hello time, max age and forward delay, and a designated bridge relays the
root's values (its own configuration is used only while it is the root itself). Only those timers pace the tree.
The Bridge ID line carries **this box's own configured** timers - remembered, printed, and unused while the box is
not the root. On the root, both lines are its own, which is why most captures show identical lines and why the
difference is easy to miss.

## Evidence

Provenance first, because it matters here: the three captures below are the ones recorded in
[#1724](https://github.com/jaylouisw/packetforge/issues/1724). This change could not re-fetch them - cisco.com
answers `403` to this session, `networkplayroom.com` failed the TLS handshake, and the WordPress host answered
`429` - so the numbers are quoted from the issue rather than transcribed from a session in hand. The mechanism
they show is not in doubt (it is what 802.1D §17.14 says a configuration BPDU carries), and the two-line split is
what a box prints; the individual page text should be re-read before this note is treated as a capture record.

| Source | What it shows |
| --- | --- |
| networkplayroom, STP lab write-up (as recorded in #1724) | A non-root's two blocks side by side: `Hello Time 10 sec  Max Age 40 sec  Forward Delay 30 sec` on the Root ID line over `Hello Time   2 sec  Max Age 20 sec  Forward Delay 15 sec` on the Bridge ID line. The root was configured 10/40/30, the non-root left at the defaults. |
| keithcla.wordpress.com, STP post (as recorded in #1724) | The same split at a single field: `Forward Delay 4` on the Root ID line over `Forward Delay 15` on the Bridge ID line. |
| Cisco Community thread (as recorded in #1724) | The question the split produces - an operator asking why the lower block "seems ignored". The answer is that the lower block *is* ignored while the box is not the root: the upper one is the one the tree runs on. |

Note what the second capture rules out: it is not "the root's line differs by a little". One line says the ports
wait 4 s, the other 15. A reader who took the wrong block at face value would mis-time a convergence by 22 s.

## What this console does

Both lines are formatted from `convergence.stpTimers()` (`engine/convergence.js`), the function that also times
the converge schedule, so no timer in the report is typed in twice:

* the Root ID line from the **elected root's** device (`stpResult.root.key` → `topology.getDevice()`), because that
  is whose BPDU values the box is running on;
* the Bridge ID line from the **answering device**;
* both from the answering device when there is no election (a console with no simulator, or a tree that has not
  been computed): nothing has arrived in a BPDU, so the box prints what it is configured with rather than inventing
  a root's numbers;
* on the root the two lines are equal by construction, which is what a box prints.

`stpTimers()` now returns `helloSec`, `maxAgeSec` and `forwardDelaySec` as well as the millisecond forms the
schedule consumes (#1724). `stpHelloSec` was a default nothing read: it is read now.

A key present but empty (`null`, `""`) is treated as absent. Before, `Number(null)` is `0`, so a fixture carrying
`"stpHelloSec": null` would have printed a hello time of zero - and on the forward delay, forwarded its ports the
instant they came up.

## Still open

* **The schedule does not adopt the root's timers yet.** `convergence.js` times each port by its own device's
  configuration, so a lab whose root advertises `forward delay 30` and whose non-root keeps 15 still converges in
  30 s on the non-root - while the report now prints the root's 30 on the Root ID line. The report is faithful to
  the hardware; the schedule is the half that is not. That is [#1722](https://github.com/jaylouisw/packetforge/issues/1722),
  and it changes timings, so it wants its own change.
* **Nothing sets these from the console.** `spanning-tree hello-time 4`, `forward-time 4` and `max-age 30` are
  each refused as an unknown sub-command whose sentence names only `spanning-tree priority <0-61440 in 4096
  steps>`, so only a fixture (`config.stpHelloSec`, `stpMaxAgeSec`, `stpForwardDelaySec`) can move them.
  `docs/CONVERGENCE.md` says so.
