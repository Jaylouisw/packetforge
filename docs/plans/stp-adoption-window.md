# Plan: the window in which a bridge adopts the root's timers

Status: steps 1-2 landed (#1757), step 3 landed earlier as the Max Age hold (#1746), step 4 with them.
Measured on `ba7ae217`, 2026-11-28. Closes **#1731**.

**One step-2 number changed on the way in.** The plan charged every bridging non-root one hello at
`max(boots) + hello`, which moved a same-instant pair from 8000 to 10000. A port transmits a configuration BPDU
the moment it becomes designated, so at power-on the root's first one leaves at the root's own boot and a box that
came up with it pays nothing; the hello is owed only by a box that powers on into a tree already running. That is
what landed, which is why no existing convergence number moved and `test/stp-adoption-window.test.js` pins the
window with staggered boots instead. Scope:
`engine/device.js` (one runtime field), `engine/convergence.js`, `engine/simulator.js`, `docs/CLI.md`,
`research/stp-root-timers-pace-the-tree.md`, and the suites named under Test strategy. The
`show spanning-tree` header is **not** touched: it prints the running timers and already reads the root's
config (`engine/cli.js:8087-8094`), which this plan leaves as it is.

## What exists today

**The adoption rule is a graph lookup with no time in it.** `stpTimersInForce()` (`engine/convergence.js:91`)
returns the root's timers when `rootDev !== dev`; `stpRootOf()` (`:97-105`) reads
`stp.bridges[dev.id].cost === Infinity` and answers `null`, so the instant a cable moves a partitioned bridge is
already on its own timers - no `Max Age` wait, no BPDU to age. `buildSchedule()` dates every STP entry at
`t.forwardAtMs` (`:205`) and adds one global `fromMs` to every device in the lab (`:238-240`), so all bridges
start the root's two forward delays at the same instant, usually zero.

**The two numbers that would date it are computed and unused.** `stpTimers()` returns `helloSec` (`:65`) and
`maxAgeMs` (`:70`); `maxAgeMs` has no production reader at all - the only one is
`test/stp-timer-lines-source.test.js:111` - and `helloSec` is read only to be printed (`engine/cli.js:8089`).
The adoption therefore changes exactly one number today: the forward delay.

**A port has one clock.** `stpPortStateAt()` (`:286-296`) asks `atMs >= t.forwardAtMs`; it has no way to say
"Listening under its own 15 s, then Listening again under the root's 4 s". `computeStp()` applies the same
single-clock answer to every port in the transient window (`engine/simulator.js:1023-1024`).

**The instant partition is pinned, and the pin landed 90 minutes ago.** `test/stp-root-timers-pace-the-tree.test.js:122-141`
cuts a link at 0 and asserts `sw3`'s entry is `30000` in the same call ("so it falls back to its own 15 s,
honestly"); `:163-177` asserts `40000` for a bridge isolated at 10 s. #1729 landed that pin 90 minutes ago, so
step 3 below reverses an assertion that was just argued for - that is the plan's one judgement call.

**The console reports the result without the window.** `converge` prints `ready <ms>` and a `basis` string
(`engine/cli.js:5621-5655`), the network-change reply prints one instant (`:5721`, from
`simulator.js:556-566`), and neither says a non-root spent its first seconds on its own timers.

**The docs describe the engine before #1722.** `docs/CLI.md:2747` still says the schedule "times each device by
its own configuration ... (#1722)". False since `stpTimersInForce()` landed.

## What is missing, ranked

1. **No instant of adoption.** A non-root runs the root's numbers from the lab's `t = 0`, whatever time it
   actually heard the root - the issue's first bullet, and the reason `hello` is inert.
2. **No ageing and no root claim.** A partition takes effect instantly; `maxAge` is carried but nothing expires.
3. **Nothing reports the window.** `converge` names the instant but not why it is that instant.
4. **A false doc sentence** (`docs/CLI.md:2747`) that now teaches the opposite of the code.

## Ordered steps

1. **S - a boot instant, and the adoption as data.** Add `bootedAtMs` to `Device` (runtime-only, default 0,
   never serialised - it is a property of a run like `runAtMs`, not of the saved lab; `engine/device.js`).
   Add `stpAdoption(topo, stp, dev, fromMs)` in `convergence.js`: it returns `{ rootDev, adoptedAtMs,
   lastHeardAtMs, expiresAtMs }`, with `adoptedAtMs = max(dev.bootedAtMs, rootDev.bootedAtMs) + hello * 1000`
   for a non-root (one hello is the worst case for the root's next config BPDU, and a designated port relays
   one while still Listening, so one interval covers the tree), `lastHeardAtMs` the same, and
   `expiresAtMs = lastHeardAtMs + maxAgeMs`. The root and a lone bridge get `adoptedAtMs = bootedAtMs`.
   `buildSchedule()` puts the four fields on the STP entry and **does not change `readyAtMs`**. Additive: every
   existing number stays where it is; the test asserts the derivation only.
2. **S - the boot window paces the ports.** `readyAtMs = adoptedAtMs + 2 * rootForwardDelay` for a bridge that
   adopts; `stpPortStateAt()` takes the adoption and answers from the device's own timers before `adoptedAtMs`
   and the root's after, with the Listening clock loaded at `adoptedAtMs`. A pair on the same instant moves
   from 8000 to 10000 (root 8000, non-root 2000 + 8 s); the default pair moves from 30000 to 32000; a non-root
   booted at 0 under a root booted at 5000 runs its own 30 s until 7000 and then finishes at 15000. `converge`
   prints `heard the root SW1 at 2000 ms` in the basis string. Simplification to state in the note: a real port
   that is already Listening keeps the value it loaded, and this model reloads at adoption.
3. **M - the BPDU ages out and the bridge claims the root.** While a bridge has no path to the elected root it
   keeps the timers it adopted until `expiresAtMs`, then runs its own; `readyAtMs` becomes
   `expiresAtMs + 2 * ownForwardDelay` for that bridge, and the reply at `simulator.js:556` follows because it
   already reads the schedule. The existing `30000` becomes `50000` (20 s age + 30 s) and `40000` becomes
   `60000`. **Needs Jay's word**: it reverses #1729's pin. Also adds `expiresAtMs` to the basis
   (`root not heard for 20 s`) so a reader can tell a slow tree from a lost one.
4. **S - the prose and the note.** `research/stp-root-timers-pace-the-tree.md`'s "What remains unresolved" is
   rewritten to describe the window and to name what is still absent (below); `docs/CLI.md:2747` stops claiming
   the schedule reads each device's own config, and the `converge` paragraph gains one sentence for the basis
   string.

## Risks

* **Two just-landed assertions reverse.** `test/stp-root-timers-pace-the-tree.test.js:138` and `:174` encode
  "instant fallback" as the honest answer. Step 3 says the honest answer is `Max Age` later. If Jay prefers the
  current pin, steps 1-2 still stand and step 3 is dropped, and #1731 stays open on its second bullet.
* **`+ hello` is a bound, not a measurement.** A capture from `debug spanning-tree events` on both sides of a
  power-on would replace it; until then the constant lives in `stpAdoption()` and one test pins the arithmetic.
* **A partition now looks 20 s slower.** Every lab that pulls an uplink and pings at +30 s starts failing where
  it passed; that is the point, but the example labs and any docs sample with a stopped clock must be re-read
  in step 3.
* **`converge` table geometry.** A longer basis widens the last column only (the widths are data-driven,
  `engine/cli.js:5644`), but `test/converge-table-geometry.test.js` pins rows and is the place a stray column
  shows up.
* **`bootedAtMs` is not a command.** No `power on at <ms>` verb is proposed; a lab cannot stagger boots from the
  console, only a test can. Adding that verb is new surface and needs Jay's approval.

## Test strategy

* New `test/stp-adoption-window.test.js`: the same-instant pair (root 8000, non-root 10000, basis naming 2000);
  the staggered pair (root at 5000, non-root finishes at 15000, and at 6000 its port is still Listening on its
  own clock); the default pair (32000); a cut at 0 (`50000`) and at 10000 (`60000`); a root with `maxAge 6`
  waiting 6 s, not 20; a lone switch unchanged at its own two delays; the root's own entry unchanged.
* Pure `stpAdoption()` cases: no election -> `rootDev null`; `cost === Infinity` -> `expiresAtMs` from the last
  heard instant; `hello` and `maxAge` read from config, defaults 2 s / 20 s.
* Regression: `test/ping-convergence.test.js`, `test/link-instant.test.js`, `test/convergence-timing.test.js`
  and `test/converge-instant.test.js` are single-switch labs and must not move - they are the guard that step 2
  only touches bridges that adopt.
* `test/stp-root-timers-pace-the-tree.test.js` updated in steps 2 and 3; `test/converge-table-geometry.test.js`
  re-run for the wider basis column.
* `npm run sweep` (or the CI legs) plus the two static scans named in `.github/workflows/ci.yml`.

## What this closes

**#1731.** It does not model a BPDU: there is still no per-port queue, no message age field, and
`debug spanning-tree events` (the evidence the issue asks for) does not exist. It also leaves, deliberately, the
global re-base at `engine/convergence.js:238-240`: one cable anywhere still restarts every bridge's clock. That
is a separate defect with a wider blast radius (`test/link-instant.test.js` builds its whole premise on it) and
belongs in its own issue, not this plan. RSTP/MSTP, PVST and `show spanning-tree detail` remain out of scope as
before.
