# Where the two `Hello Time … Max Age … Forward Delay` lines get their numbers

Question: `show spanning-tree` prints a timer line under the Root ID block and again under the Bridge ID block.
Which device's timers does each line report, and does this console print the same numbers twice?

Asked because the block that landed for #1713 wrote the line as a literal — `Hello Time   2 sec  Max Age 20 sec
Forward Delay 15 sec`, twice — while the model keeps `stpForwardDelaySec` and `stpMaxAgeSec` on each device's
config and the convergence schedule waits on them (`engine/convergence.js`). A fixture could therefore configure a
4 s forward delay, forward ports at 8 s, and still be told by its own report that the delay is 15 s.

## What the captures show

Three independent recordings, and they agree on the rule:

1. **networkplayroom, "Lab: Spanning Tree Protocol"** — root SW2 given `spanning-tree vlan 1 hello-time 10`,
   `forward-time 30`, `max-age 40`; a non-root SW1 then prints

   ```
   Root ID Priority 4097
   Address fa16.3ea5.285b
   Cost 4
   Port 6 (GigabitEthernet1/1)
   Hello Time 10 sec  Max Age 40 sec  Forward Delay 30 sec
   Bridge ID Priority 8193 (priority 8192 sys-id-ext 1)
   Address fa16.3e68.4cae
   Hello Time 2 sec  Max Age 20 sec  Forward Delay 15 sec
   ```

   The first line is the root's; the second is SW1's own, still unconfigured. The same page shows SW1 transmitting
   BPDUs every 10 s (`debug spanning-tree bpdu transmit`) while its own configured hello remains 2.

2. **keithcla.wordpress.com, "Default STP Timers"** — `Forward Delay 4 sec` on the Root ID line over
   `Forward Delay 15 sec` on the Bridge ID line, with the summary: "Non-root bridges will still show the local
   timer values, but will use the root values."

3. **Cisco community, "STP timers ?"** — the same asymmetry asked as a question ("under the BRIDGE ID section …
   the timers are still set to 2, 15, 15"), answered that only the root's timers govern convergence.

The mechanism is the BPDU: the root advertises its three timers in the configuration BPDU, so every bridge knows
them, and 802.1D says a non-root adopts the root's values (the local ones are remembered but unused). Cisco's
"Understand and Tune Spanning Tree Protocol Timers" (doc 19120) states the same from the other side —
"Effectively, only a timer that is configured on the root bridge of the STP is important" — and gives the
defaults and the ranges (hello 2 s, 1–10; max age 20 s, 6–40; forward delay 15 s, 4–30).

So: **Root ID line = the root's timers; Bridge ID line = this box's own.** They coincide on a root, and on a
non-root they differ whenever the two configurations differ. Neither line is the factory's by definition, which
is what the literal got wrong.

Sources:
- https://www.networkplayroom.com/2017/10/lab-spanning-tree-protocol.html (lab transcript, VIRL, IOS)
- https://keithcla.wordpress.com/2012/03/06/default-stp-timers/ (catalyst capture, with the asymmetry spelled out)
- https://community.cisco.com/t5/switching/stp-timers/td-p/838321 (the same question from an operator)
- https://www.cisco.com/c/en/us/support/docs/lan-switching/spanning-tree-protocol/19120-122.html (defaults, ranges,
  and the rule that only the root's timers matter)
- IEEE 802.1D-2004 §17.14 (the defaults) and §17.13/17.15 (timers carried in configuration BPDUs)

## What this console now prints

`engine/cli.js` builds the line from `stpTimers()` twice: the Root ID line from the device the election named as
root (`stpResult.root.key`), the Bridge ID line from the box being asked. On the root those are one device, so the
two lines are identical, as the captures show. Where no election has run, both lines read the local device's
timers — a console with nothing measured still knows its own configuration, and has no root to quote.

`stpTimers()` grew `helloSec`, `maxAgeSec` and `forwardDelaySec` alongside the millisecond fields it already had,
so the report and the schedule cannot disagree about a number either of them prints.

Aging Time is deliberately not part of this: it stays the forwarding-database ageing (`MAC_AGE_MS`), not the max
age on the line above (`research/show-spanning-tree-aging-time.md`), and a test pins that moving the max age does
not move it.

## Unresolved

- **The model's convergence follows the root's timers now** (#1722): see
  [stp-root-timers-pace-the-tree.md](stp-root-timers-pace-the-tree.md), which carries the evidence for the other
  half of this rule, the code that applies it, and the window (before the first BPDU, after one ages out) that is
  still not modelled.
- **Whether a box prints the *propagated* timers or the root's local ones when the root's own config was changed
  without the change reaching a neighbour yet** — the captures all show steady state. The model has no BPDU
  propagation delay for timers, so it prints the root's configuration immediately.
- **MST instances.** One tree here; a real MSTP box prints a timer line per instance, and the root may differ per
  instance. Out of scope until MST exists.
- **Aging Time varies by platform** — the same lab prints `300 sec` on three switches and `15 sec` on a fourth
  (`show mac address-table` ageing, apparently configured independently of STP). Already recorded in
  `research/show-spanning-tree-aging-time.md`; this console uses its own CAM ageing.
