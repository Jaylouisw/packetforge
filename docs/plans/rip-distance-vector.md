# Plan: RIP is the roadmap's one absent protocol, and 69 device specs say they run it

Status: forward plan, no code. Measured on `2d71aeb4`, 2026-11-19. Closes no open issue — the queue holds one
request (#130, a Ubiquiti device) and nothing in it touches routing. New protocol surface, so it is
**needs Jay's approval** — but it is the roadmap's own named gap (`docs/ROADMAP.md:30`, *"RIP: no
implementation, and no reference to it under `engine/`"*), not an invention. Steps 1, 2 and 6 are additive
(a model, a command, a doc row); steps 3-5 change what the route table can contain.

`docs/ROADMAP.md:30` lists RIP as the **only** Absent row in the simulation-engine table: every other line is
Modelled or Partial. At the same time 69 device specs describe hardware that runs RIP, and 19 of them promise
RIP v2 by name (`devices/cisco/c1300-16t-2g.json:59`, notes: *"RIP v2, static routing and PBR"*); others
name RIP generally (`devices/aruba/2540-24g-4sfp.json:6`, *"static and RIP routing"*). An operator can
catalogue a C1300, read its own note, and then find that no command in the console begins with `r`. This plan
is the smallest honest way to close that gap: config, distance vector, table, timers, view.

## What exists today

| fact | evidence |
|---|---|
| the roadmap says it is absent | `docs/ROADMAP.md:30`; `docs/SIMULATION.md` has §5.5 OSPF, §5.6 BGP and no RIP row at all |
| and it is | `grep -rniE '\brip\b' engine/` returns three Cisco documentation URLs in comments (`engine/cli.js:1954`, `:1966`, `:6044`) and nothing else |
| no config word | `CONFIG_WORDS` `engine/cli.js:171-193` holds `router`, `bgp`, `ospf`; the `router` branch knows only BGP (`:1636`) |
| the shape to copy | `router bgp <as>` is a flat config command, not a sub-mode (`:1636`, `_bgp()` `:2804`); OSPF's body is `ospf router-id/area/…` (`:1712`, `_ospfConfig()`); there is no `config-router` prompt anywhere (`grep -c config-router engine/cli.js` is 0) |
| the table has no source for it | `Device.routeTo()` `engine/device.js:1016` tries connected, static, BGP, OSPF, then the default gateway; `routesTable()` `:1285` emits codes `C`, `S`, `O`, `B` |
| distances exist, RIP's does not | `Device.routeDistance()` `engine/device.js:1205-1219`: connected 0, static as configured, OSPF 110, BGP 20/200, default 254. 120 appears nowhere |
| the legend has no `R` | `show ip route` prints `Codes: C - connected, S - static, O - OSPF, B - BGP, * - candidate default` (`engine/cli.js:5999`) |
| protocols run only at run start | `computeOspf()` `engine/simulator.js:1392`, `computeBgp()` `:1706`, called at `:626`, `:763`, `:2456`, `:4123` — every path a run can take |
| timers are per process and there are four | `engine/convergence.js:254-268` exports `stpTimers`, `ospfTimers`, `vrrpTimers`, `dhcpTimers`; `buildSchedule()` emits one entry per running process |
| a saved lab cannot carry a RIP block | the config whitelist in `Device.serialize()` `engine/device.js:1413-1435` names `ospf` and `bgp` and no `rip` |
| there is no summary view | `show ip protocols` is a pointer sentence — `SHOW_IP_POINTERS.protocols` `engine/cli.js:651` sends the reader to `show ip ospf`, `show ip bgp summary` and `show ip route` |
| help is pinned in both directions | `test/help-completeness.test.js` compares `help` against the parser with hand-written lists, and `docs/CLI.md` is checked by `test/docs-show-commands.test.js` |

## What is missing or weak, ranked

1. **No process.** 19 datasheets promise `router rip`; typing it today is `% Unrecognized`. Everything else
   on this list depends on this one word.
2. **No distance vector.** OSPF is a pure graph problem (`engine/ospf.js:1-10` computes, it does not speak);
   RIP needs the opposite shape — hop count, split horizon, a ceiling of 15 — and nothing computes it.
3. **No table entry, so no AD 120.** Without (2) the route table has no `R` row, no `[120/n]`, and
   `routeDistance()` cannot price one. Floating statics against RIP (115 beats 120) are unbuildable.
4. **No timers.** 30 s update / 180 s holddown / 240 s flush is the most teachable fact in RIP and
   `buildSchedule()` has no line for it.
5. **No view.** `show ip rip database` does not exist, and `show ip route` cannot print a code it has never
   had.
6. **The registry's own notes are unverifiable.** Not a bug in the specs (the hardware does run RIP) but a
   review trap: a future worker reading `notes` may assume the engine already does.

## Steps

**1. Model and validation (S).** `engine/rip.js`: `RIP_ADMIN_DISTANCE = 120`, `RIP_MAX_METRIC = 15`,
`RIP_INFINITY = 16`, `RIP_UPDATE_SEC = 30`, `RIP_HOLDDOWN_SEC = 180`, `RIP_FLUSH_SEC = 240`,
`RIP_MULTICAST = '224.0.0.9'` (kept as a fact of the protocol even though nothing encodes a datagram yet),
`validateRip(cfg)` returning `{ ok, errors }` with codes in the house style — `E_RIP_VERSION` (not 1 or 2),
`E_RIP_NETWORK` (not a dotted quad), `W_RIP_NO_INTERFACE` (the network statement matches no configured
subnet, which IOS accepts and then advertises nothing). Export from `engine/index.js` beside `ospf`/`bgp`.
`test/rip.test.js`: version bounds, network parsing, the constants, and a board with no `rip` key validating
as disabled.

**2. The command and the save (S).** One arm beside `router bgp` (`engine/cli.js:1636`): `router rip` and `no
router rip`, plus the flat body this console uses for the other two protocols (`rip network <A.B.C.D>`, `rip
version 1|2`, `rip auto-summary` / `rip no auto-summary` (the `no` inside the process word, the shape `no vrrp
<vrid> preempt` already uses), `rip passive-interface <port>`), with the same `no`-form entries beside `no
router bgp` and `no ospf` (`:733`, `:735`) and the same refusal-by-name shape. `rip network` stores the *major*
network the address falls in — that is what IOS does and what makes `network 10.0.0.0` enable `10.1.2.0/24`; say
so in the acknowledgement. Print the block from `show running-config` beside OSPF's (`engine/cli.js:6928-6935`)
and add `rip` to the serialize whitelist (`engine/device.js:1413`) with a restore path. `_help()` gains the
line; `test/help-completeness.test.js`'s config list and `docs/CLI.md`'s command table move in the same PR or
the suite goes red — that is the guard working, not an obstacle.

**3. The distance vector (M).** `computeRip(topo)` in `engine/rip.js`, pure and deterministic: build the
router adjacency from configured interfaces on the RIP network list (same-subnet via `net.sameSubnet`, both
ports enabled, link up, not `passive-interface`), seed each router with its connected subnets, then run
Bellman-Ford to a fixed point with hop counts, split horizon (do not advertise a route back out the interface
it was learned on) and a hard stop at 16. Sort neighbours by the numeric address, never by `Map` insertion
order — the rule `docs/plans/flow-determinism.md` sets. Returns `{ [devId]: [{dest, mask, nextHop, iface,
metric, learnedFrom}] }`. Unit test: a three-router line converges to metrics 1/2/3; a cut link drives the
route to 16 and removes it; a two-router loop does not oscillate.

**4. Install into the table and print it (M).** `Simulator.computeRip()` beside `computeOspf()`
(`engine/simulator.js:1392`), called at all four setup sites (`:626`, `:763`, `:2456`, `:4123`) so a ping,
a trace and a flow see one table. `Device.routeTo()` gains a `ripRoutes` branch **after** OSPF and before the
default gateway, priced by a new `if (r.type === 'rip') return 120` in `routeDistance()`; `routesTable()`
emits `code: 'R'` rows with metric = hop count; the Codes line at `:5999` names `R - RIP`. `show ip rip
database` prints the local table from the same `dev.ripRoutes` the data plane reads, so the two cannot
disagree. Test `test/rip-wire.test.js` in the sense `test/ospf-wire.test.js` uses — three routers with **no**
static routes, the far subnet reachable only after RIP installs it — plus one AD table test: a static at 115
beats a RIP route, a RIP route at 120 beats the default at 254, and OSPF at 110 beats RIP.

**5. Timers (S).** `ripTimers(dev)` and `runsRip(dev)` in `engine/convergence.js`, one `buildSchedule()`
entry with `readyAtMs` = the first update (30 s) and the basis string naming it; a loss schedules holddown
(180 s) then flush (240 s) from the change instant, re-based by `fromMs` (`:152`, applied at `:193`) like
every other process.
`test/rip-convergence.test.js`: nothing is installed at t=0, the route appears at 30 s, and a pulled cable
leaves the route in holddown before it disappears.

**6. Docs (S).** A §5.10 after LLDP in `docs/SIMULATION.md` with the verdict table (Modelled: config, hop
count, split horizon, timers; Absent: authentication, redistribution, RIPng, triggered updates), the roadmap
row flipped to Modelled in the same PR (`docs/ROADMAP.md:30`), and a `docs/CLI.md` section with a real
transcript of `router rip` → `show ip route` → `show ip rip database`.

## Risks

- **Counting to infinity.** Split horizon alone does not stop every two-node loop; cap at 16, drop at 16,
  and test the loop rather than reasoning about it.
- **Determinism.** RIP is the first protocol here whose answer depends on iteration order. Fixed neighbour
  sort, no loss, no timing jitter — the `flow-determinism` rule applies to the route table too.
- **AD collisions.** 120 must sit between OSPF 110 and the default 254, and static 115 must win; that is one
  table test, not three.
- **Classful network statements.** `network 10.0.0.0` enabling `10.1.2.0/24` is correct and surprising; if
  the plan is implemented as "exact subnet match" the feature will look broken to anyone who knows IOS.
- **No bytes.** OSPF and BGP in this engine are computed graphs, not encoders (`engine/ospf.js:1-10`), and
  `test/ospf-wire.test.js` means "in the path", not "on the wire". Inventing RIPv2 datagrams here would be a
  different, larger PR and would let `show ip rip database` describe packets that never existed.
- **Scope creep into the specs.** The 69 notes are true of the hardware; do not edit them in this stream.

## Test strategy

`test/rip.test.js` (model, validation), `test/rip-wire.test.js` (in the data path, cut link, AD table),
`test/rip-convergence.test.js` (timers), plus the existing `help-completeness`, `docs-show-commands` and
`no-command-swallows-a-word` suites as the gates on steps 2 and 4. Every suite is auto-discovered by
`scripts/run-tests.js`, so no runner edit is needed.

## Left out deliberately

RIPng and IPv6 (IPv6 has no dynamic routing path here at all), plain-text/MD5 authentication (the VRRP
precedent stores the text and models nothing), redistribution into or out of OSPF/BGP, `timers basic`,
offset-lists, triggered/partial updates, `debug ip rip`, `show ip protocols` as a shared view for all three
protocols, and any web-canvas surface. Each is a later plan; none is needed to make `router rip` honest.

## Size and issues

Overall **M**: step 3 is the only one a worker should not split, and steps 3-4 must land in that order by
one worker. Closes **no** open issue — #130 is a device request and the queue holds nothing else. It closes
`docs/ROADMAP.md:30`, the last Absent row in the engine table.
