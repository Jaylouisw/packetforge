# Convergence

A lab that only shows the converged answer teaches half of network engineering. The other half is
the interval between *power on* and *working*, where the link lights are green and nothing passes.

```
SW1#converge
Process  Device  Ready     Basis
stp      SW1     30000 ms  listening + learning (15 s forward-delay each)

Fully converged at 30000 ms.
```

```
SW1#ping 10.0.0.2 1 at 5000
Type escape sequence to abort.
Sending 1, 100-byte ICMP Echos to 10.0.0.2, timeout is 2 seconds:  (at t=5000 ms)
.
% Still converging at t=5000 ms: stp on SW1 (ready at 30000 ms)
Success rate is 0 percent (0/1)
```

Note what that last line is not: it is not `Request timed out`. Nothing was lost. The network was
not up yet, and the engine says which process is not finished and when it will be.

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

Each has its standard default. **How much of it you can actually change is worth stating plainly**,
because "overridable in configuration" would otherwise read as "there is a command":

| Timer | Can you change it? |
|---|---|
| VRRP advertisement | **Yes, from the CLI, per interface** — `vrrp <vrid> ip <addr> … advertise <seconds>` sets it when the group is created, and `vrrp <vrid> advertise <s>` changes an existing group (before one exists it is refused: `% No VRRP group 1 on Gi0/0`). Stored as `advertSec`; `show running-config` re-emits it only when it is not the 1 s default |
| STP forward delay, max age | Only by writing the device config directly: `stpForwardDelaySec`, `stpMaxAgeSec` |
| OSPF hello, exchange, SPF hold, dead | Only by writing the device config directly: `ospf.helloSec`, `ospf.exchangeSec`, `ospf.spfDelaySec`, `ospf.deadSec` |
| DHCP exchange | Only by writing the device config directly: `dhcpExchangeSec` (default 1 s, which is what `leaseAtMs` is computed from) |

### Where each timer is actually read from

"That key is read from `dev.config`" hides three different shapes, and one of them is a trap. Measured
by setting each key and reading the timer object back:

| Timer | Path | Measured override → effect |
|---|---|---|
| STP forward delay, max age | `dev.config.stpForwardDelaySec`, `dev.config.stpMaxAgeSec` — **flat** | `{4, 11}` → `listenEndMs 4000`, `learnEndMs 8000`, `forwardAtMs 8000`, `maxAgeMs 11000` |
| OSPF hello, exchange, SPF hold, dead | `dev.config.ospf.helloSec`, `.exchangeSec`, `.spfDelaySec`, `.deadSec` — **nested under `ospf`** | `{helloSec: 2, exchangeSec: 3, spfDelaySec: 9}` → `adjacentAtMs 5000`, `routesAtMs 14000` |
| DHCP exchange | `dev.config.dhcpExchangeSec` — flat | `7` → `leaseAtMs 7000` |
| VRRP advertisement | the **group** object, not the device: `advertSec` (CLI) or `advertCs` (centiseconds) | `advertCs: 200` → `advertSec 2`, `masterDownMs 6609.375` |

The arithmetic, so a reading can be predicted rather than looked up (`engine/convergence.js:58-79`):
`listenEndMs = forwardDelay × 1000`, `learnEndMs = forwardAtMs = forwardDelay × 2000` — the forward delay
counted twice, once per state — while `maxAgeMs` only ever lands in `maxAgeMs`; and for OSPF
`adjacentAtMs = (helloSec + exchangeSec) × 1000`, `routesAtMs = adjacentAtMs + spfDelaySec × 1000`, with
`deadSec` read and validated but never placed in the schedule. Three readings check the formula against the
engine: the defaults give `(10 + 1) × 1000 = 11000` and `11000 + 5000 = 16000`; `{helloSec: 2,
exchangeSec: 3, spfDelaySec: 9}` gives `5000` and `14000`; and `helloSec: null` — which `num()` treats as
zero rather than as a missing key — gives `(0 + 1) × 1000 = 1000` and `6000`, exactly the rows in the
garbage table below. Knowing the formula is what makes that last one look wrong instead of merely small.

The trap is the OSPF shape. `dev.config.ospfHelloSec = 2` is **read by nothing** and produces no
warning — the timers stay at `helloSec 10, deadSec 40, adjacentAtMs 11000, routesAtMs 16000`, which
looks exactly like a lab that is converging slowly for another reason. The nested
`dev.config.ospf.helloSec` is the one that lands.

Two more measured details worth having in writing:

- **`advertCs` is centiseconds and is validated.** `validateGroup()` rejects `0`, `-5` and `2.5` with
  `E_ADVERT_RANGE` (*"advertCs must be a positive integer number of centiseconds"*) and accepts `200`.
  It exists so a lab can dial advertisements below the 1 s default — `advertCs: 250` gives a 2.5 s
  interval and `masterDownMs 8109.375`. Note *how* it rejects: `validateGroup()` never throws, it
  returns `{ ok, errors }` with one `{ code, message }` per fault, so `try { validateGroup(g) } catch`
  catches nothing at all and every value looks accepted:

  ```js
  validateGroup({ vrid: 1, ips: ['10.0.0.1'], advertCs: 0 }).errors[0]
  // { code: 'E_ADVERT_RANGE',
  //   message: 'advertCs must be a positive integer number of centiseconds, got 0' }
  validateGroup({ vrid: 1, ips: ['10.0.0.1'], advertCs: 200 })   // { ok: true, errors: [] }
  ```

  The `message` quotes the value as parsed, which is why the string `'2.5'` reports `got 2.5` — the
  number, not the spelling you typed.
- **When both fields are set, the two modules disagree.** `engine/vrrp.js`'s `advertInterval()` prefers
  **`advertCs`** (`{advertSec: 3, advertCs: 200}` → `2`), while `convergence.vrrpTimers()` prefers
  **`advertSec`** (same input → `advertSec 3`, `masterDownMs 9609.375`). Set one field or the other; if
  you set both, the readiness number a lab shows and the interval its advertisements use will differ.
- **A key set to `null` means zero, not "use the default".** Every timer in this module goes through
  `num(v, dflt)` (`engine/convergence.js:46`), which is `Number(v)` accepted whenever it is finite and
  `>= 0` — and `Number(null)` is `0`. So a config that carries an explicit `null` (a JSON round-trip of an
  unset field, a `delete` that wrote the key back empty) does not fall back, it produces the smallest
  possible schedule. Measured:

  | call | result |
  |---|---|
  | `stpTimers({})` | `forwardDelaySec 15`, `forwardAtMs 30000` |
  | `stpTimers({ config: { stpForwardDelaySec: null } })` | `forwardDelaySec 0`, **`forwardAtMs 0`** — the port forwards instantly, which is the exact behaviour this module was written to stop |
  | `vrrpTimers({})` | `advertSec 1`, `masterDownMs 3609.375` |
  | `vrrpTimers({ advertSec: null })` | `advertSec 0`, `masterDownMs 609.375` |
  | `ospfTimers({ config: { ospf: {} } })` | `adjacentAtMs 11000`, `routesAtMs 16000` |
  | `ospfTimers({ config: { ospf: { helloSec: null } } })` | `helloSec 0`, `adjacentAtMs 1000`, `routesAtMs 6000` |

  A **negative** value goes the other way and is just as silent: `-5` fails the `>= 0` test and the default
  comes back (`dhcpTimers({ config: { dhcpExchangeSec: -5 } })` → `exchangeSec 1`), so a stray minus sign
  looks like a config that was ignored while a `null` looks like a config that was obeyed. Neither warns,
  and `stpTimers` keeps `maxAgeMs 20000` in the null case because max age is read separately — so the
  result is not even internally consistent.

  Every row of that table was taken again at `1f6441f3`, and they all reproduce, including the two that are
  easiest to get wrong by quoting from memory (`stpTimers({config:{stpForwardDelaySec:null}})` really does
  answer `forwardDelaySec 0` with `maxAgeMs 20000` beside it, and the negative-value case really does return
  the default):

  ```sh
  node -e 'const c=require("./engine/convergence");const s=x=>console.log(JSON.stringify(x));
  s(c.stpTimers({}));s(c.stpTimers({config:{stpForwardDelaySec:null}}));
  s(c.vrrpTimers({}));s(c.vrrpTimers({advertSec:null}));
  s(c.ospfTimers({config:{ospf:{}}}));s(c.ospfTimers({config:{ospf:{helloSec:null}}}));
  s(c.dhcpTimers({config:{dhcpExchangeSec:-5}}))'
  ```

  The same table was taken a third time on 2026-11-12 and again every row reproduces, so this is not a note
  that was true once. Two further shapes are worth adding because they are the ones a reader would mis-quote:

  | call | result |
  |---|---|
  | `vrrpTimers({ advertCs: 200 })` | `advertSec 2`, `masterDownMs 6609.375` |
  | `vrrpTimers({ advertCs: 250 })` | `advertSec 2.5`, `masterDownMs 8109.375` — the sub-second dial the page promises |
  | `vrrpTimers({ advertSec: 3, advertCs: 200 })` | `advertSec 3`, `masterDownMs 9609.375` — while `vrrp.advertInterval()` on the same object answers **2** |
  | `ospfTimers({ config: { ospf: { helloSec: 2, exchangeSec: 3, spfDelaySec: 9 } } })` | `adjacentAtMs 5000`, `routesAtMs 14000` |
  | `ospfTimers({ config: { ospfHelloSec: 2 } })` | unchanged — `helloSec 10`, `adjacentAtMs 11000`, `routesAtMs 16000`, with no warning |

  The other paragraphs on this page rest on four literals, and each has a home: `num()` at
  `engine/convergence.js:46` (`Number.isFinite(n) && n >= 0`, which is why `null` becomes `0` and `-5` does not),
  the `E_ADVERT_RANGE` message built with `String(group.advertCs)` at `engine/vrrp.js:192` (hence `got 2.5` for the
  string `'2.5'`), `'% Nothing in this lab runs a control plane that converges over time'` at `cli.js:7539`,
  `'% Still converging at t=' …` at `cli.js:7341`, `'Network converges again at '` at `cli.js:7619`, and the
  `ospf hello` refusal `'% Usage: ospf router-id <ip> | ospf area <id>'` at `cli.js:3998`.

  The dead-constant claim was re-measured the same way rather than trusted: `grep -rn stpHelloSec engine/ test/`
  answers exactly one hit, `engine/convergence.js:32`, which is the definition. Nothing reads it.
- **"Lease" means two different numbers, and only one of them is a lifetime.** `dhcpTimers().leaseAtMs`
  is the *exchange* timer multiplied by a thousand — `leaseAtMs = exchangeSec × 1000` from the same
  `dhcpExchangeSec` — so it moves whenever the exchange does and says nothing about how long a client keeps
  the address. The real lifetime is the pool's `leaseSec`, default **86400**
  (`engine/dhcp.js:37`), spent when the lease is recorded:
  `expiresStep = step + max(1, floor(leaseSec)) × STEP_SECONDS` (`engine/dhcp.js:508`).
  `validatePool()` refuses a non-positive value rather than reading it as a zero-length lease —
  `E_DHCP_BAD_LEASE: 'DHCP pool lan1: leaseSec "0" must be a positive number of seconds.'`, measured, and
  asserted at `test/dhcp.test.js:194` — while an **absent** key validates cleanly and normalises to 86400.
  A lab that shortens the convergence schedule and a lab that shortens the lease are tuning two unrelated
  numbers.
- `masterDownInterval(group, skew)` takes the **skew in seconds** as its second argument, not the
  priority. Passing `100` — the priority — returns `103` seconds, because it dutifully adds
  `3 × 1 s + 100 s`. The defaults are the ones in `engine/convergence.js` — the table is `const C` inside that
file, and `module.exports` publishes it as **`DEFAULTS: C`**, so `require('.../engine').convergence.DEFAULTS`
is the object to read and `C` is the name you will see in a stack trace or a `grep`.

| Process | Default | Source |
|---|---|---|
| STP forward delay | 15 s | 802.1D §17.14 — a forwarding port waits 2× this |
| STP max age | 20 s | 802.1D |
| OSPF hello | 10 s | RFC 2328 on a broadcast segment |
| OSPF dead | 40 s | 4× the hello interval, the RFC 2328 relationship. Read into `ospfTimers()` and validated (`deadSec` must be at least `helloSec`), but it never reaches the schedule: `adjacentAtMs` and `routesAtMs` are built from hello + exchange + SPF only, so no adjacency ever expires on its own |
| OSPF exchange | 1 s | modelled DBD/LSDB synchronisation |
| OSPF SPF delay | 5 s | the hold before the first route lands |
| VRRP advertisement | 1 s | RFC 5798 §6.1 |
| DHCP exchange | 1 s | DISCOVER/OFFER/REQUEST/ACK |
| STP hello | *(none)* | `engine/convergence.js` carries `stpHelloSec: 2` in its constant table and **nothing reads it** — a BPDU's hello pacing is not modelled, so no timer expires on a missed hello. STP state expires on max age (20 s) instead. The constant is a leftover, and its presence in the code is not evidence that hellos are simulated. |

### How each readiness number is computed

The `Ready` column is arithmetic, not a lookup, and every formula below was checked against a live
`converge` on this tree:

| Process | Formula | Measured |
|---|---|---|
| STP | `listing = forward delay`, then a second forward delay to learn, so `2 × 15 s` | `30000 ms  listening + learning (15 s forward-delay each)` |
| OSPF | `hello + exchange` to form the adjacency, `+ SPF hold` for the first route | `16000 ms  hello 10 s + exchange, then SPF hold` (10 + 1 + 5) |
| VRRP | `3 × advertisement + skew`, where `skew = (256 − priority) / 256` s and priority 255 skips it | `3609.375 ms  3 x advertise 1 s + skew` at priority 100 (3 + 156/256) |
| DHCP | the exchange itself, with no queueing behind it | `1000 ms  DISCOVER/OFFER/REQUEST/ACK` |

`converge` answers with **one row per device per process**, not one row for the lab, so the summary
line is the maximum of everything listed rather than the figure for the device you typed it on.
Measured on a four-device lab (two switches cabled to each other, two routers cabled to each other):

```
Router-d6#converge
Process  Device          Ready     Basis
ospf     Router-d6       16000 ms  hello 10 s + exchange, then SPF hold
ospf     Router-d7       16000 ms  hello 10 s + exchange, then SPF hold
stp      Switch (L2)-d1  30000 ms  listening + learning (15 s forward-delay each)
stp      Switch (L2)-d2  30000 ms  listening + learning (15 s forward-delay each)

Fully converged at 30000 ms.
```

Two details that transcript settles: the rows cover **every device on the board**, so the two routers
and the two switches — which share no cable in that lab — are timed in the same answer, and neither
island is filtered out for being unrelated to the device the command was typed on. And the total is
`30000 ms`: the slower process wins the headline even though the OSPF on that router lands at
`16000 ms`.

Two of the four formulas are worth reading twice. **VRRP is the only one whose number is not a round figure** —
`3609.375 ms` at the default priority 100, because the RFC's skew time is a fraction of a second; a
higher priority shrinks it — measured `3218.75 ms` at priority 200 (3 + 56/256) and a clean `3000 ms`
at priority 255 (the address owner, whose skew is zero by the RFC). And
**OSPF's dead interval does not appear in the formula at all**: `deadSec` is read and validated but
never reaches the schedule, so an adjacency cannot expire on its own and the readiness number is
always `hello + exchange + SPF`.

**Reproducing the OSPF row.** It needs two speakers, not one — a lone router with `ospf router-id`
configured and no peer has nothing to converge toward and `converge` says so. Two `generic-router`
specs joined on one port each, an `ip address` on both ends of that link plus a second addressed port
for the route to ride, `ospf router-id` on each and `network <link>/24 area 0` on both, then:

```text
R1#converge
Process  Device  Ready     Basis
ospf     R1      16000 ms  hello 10 s + exchange, then SPF hold
ospf     R2      16000 ms  hello 10 s + exchange, then SPF hold

Fully converged at 16000 ms.
```

Both routers appear because the schedule is per speaker, and both read `16000` because they were
configured identically. Two things about that recipe were measured rather than assumed, and the first
one is a surprise:

- **A peer is not required.** One router with `ospf router-id` and a `network` line and nothing on the
  other end of the cable still prints `ospf R1 16000 ms` — the schedule is computed from configuration,
  not from an adjacency, so `converge` will happily promise a time for a speaker that has nobody to
  talk to. `show ip ospf neighbor` is the command that answers "is anybody there" — it prints its header and then
  `(no adjacencies - no neighbour passed the passive, subnet and area checks)`, which names the three
  checks rather than leaving an empty table to interpret.
- **`hello` is not a console command.** `ospf hello 5` answers `% Usage: ospf router-id <ip> | ospf
  area <id>`, so the two rows only separate if the topology JSON gives a device `ospf.helloSec`, which
  is what `convergence.ospfTimers()` reads (`num(ospf.helloSec, C.ospfHelloSec)`). Write the number into
  a lab file, not at the prompt.

`engine/convergence.js` is pure: it reads configuration and returns times. No clock, no state, no
side effects. The simulator decides what to do with the answer.

### BGP has no timer here, and that is deliberate

The table above is the whole list. BGP is missing from it because `computeBgp()` runs
synchronously — there is no ConnectRetry, no hold timer, no session that sits in `Active` for a
while. Two routers configured as eBGP peers are `Established` **at t=0**:

```
R1#ping 10.0.12.2 at 0
R1#show ip bgp
Neighbor   V  AS     State        Reason
10.0.12.2  4  65002  Established  eBGP
1 of 1 neighbour(s) established
```

BGP *converges* in no time, and it no longer needs a run either: `show ip bgp` derives the sessions
before it answers, so the same table appears with or without the `at 0` above. (Until recently a
plain show said `(no neighbours have been evaluated yet - run a simulation)` and only a `ping` or an
`at` question filled it in.) The tell is `converge` in a lab whose only protocol is BGP: `% Nothing in
this lab runs a control plane that converges over time`. If a lab mixes BGP with
OSPF or STP, the other process sets the finish time and BGP's routes are there from the first
instant. A real BGP session's 30 s ConnectRetry and 180 s hold time are not modelled, so do not
read this page's numbers as covering them.

## What this does not model

Honestly, and by design:

- **Real-time interleaving.** Nothing runs a clock during a run. A question is answered *as of* an
  instant, computed from the timers. Two processes that would overlap in reality are each either
  finished or not.
- **Timer jitter and retransmission.** A hello is heard, not lost. There is no dead-interval expiry,
  no 3-missed-hellos neighbour teardown, no exponential backoff.
- **STP port roles changing over time.** Roles come from the steady-state computation; only the
  transitional Listening/Learning state is timed.
- **Several changes inside one window.** `markChange()` keeps the *latest* change instant, so a lab
  where three cables are pulled in a second re-bases once from the last one rather than queueing
  three overlapping windows. Flapping, half-broken links and a partially degraded link are not
  modelled either ([LINK-STATE.md](LINK-STATE.md)).

Note that **re-convergence after a topology change is** modelled — it has its own section below,
because it is the half of the feature a lab actually exercises.

Each of those is a real gap and each is a candidate for its own issue. What exists is the part a
technician meets first: the honest *duration* of coming up.

## Re-convergence: a cable is pulled

Everything above describes a network that is being powered on. The same timers run again whenever
the topology *changes*, and they run from the instant of the change:

```bash
R1#link down l5 at 10000
Link l5 (SW1:Fa0/1 <-> SW2:Fa0/1) is now down.
Network converges again at 40000 ms.
```

Ten seconds plus the two forward delays, because a switch that has to bring a new port into
forwarding walks it through Listening and Learning just as it does at boot. Ask inside that window
and the answer is `reason: 'converging'`, naming the processes that are not done; ask after it and
the alternate path is carrying traffic.

`getConvergence()` reports `fromMs` — the instant the schedule is based at — and includes the change
itself as an entry, so nothing in the schedule claims to be ready before the event that caused it.

The change instant lives on the topology (`lastChangeAtMs`) rather than on a `Simulator`, so a lab
reloaded from disk still knows when its cable was cut and still reports the correct window.

Only 802.1D timers are modelled: RSTP's sub-second proposal/agreement is not, so a simulated
re-convergence costs the same 30 s as a boot. See [LINK-STATE.md](LINK-STATE.md).
