# Plan: a route crosses two OSPF areas and `show ip route` still calls it intra-area

Status: forward plan, no code. Measured on `f2898cd3`, 2026-11-21, with a four-router probe lab
(`ASR 1001-X` specs from the catalogue; r1 area 1 — r2 areas 1/2 — r3 areas 2/3 — r4 area 3, one /24
per link).
Closes **no** open issue — the tracker holds one device request (#130) and four open pull requests,
none about OSPF. Scope: `engine/ospf.js` (graph construction, SPF, `routesFromSpt()`),
`engine/simulator.js` `computeOspf()`, `engine/device.js` `routesTable()`, `docs/SIMULATION.md`
§5.5, `docs/CLI.md`, one new `research/ospf-inter-area.md`, one new suite.

## What exists today

**Areas gate adjacency and nothing else.** `normalizeLink()` returns `null` the moment the two ends
disagree on a port's area (`engine/ospf.js:379`), and that is the only place `area` is consulted.
`buildGraph()` (`:397`) then puts every surviving edge into **one** graph, each edge carrying an
`area` field that nothing downstream reads: `spf()` (`:511`) walks the whole graph, and
`routesFromSpt()` (`:595`) advertises every reachable router's connected networks as `code: 'O'`
(`:661`). The simulator does the same walk in its own loop (`engine/simulator.js:1599` builds the
graph, `:1636` runs one SPF per root, `:1646-1700` installs rows) and never calls `routesFromSpt()`,
so the rule exists twice.

**Measured, four routers (r2 and r3 are given `ospf area 0` as their default area and then move both
interfaces out of it, so neither has a port in area 0):**

```
r1 (area 1)              r2 (areas 1, 2)          r3 (areas 2, 3)          r4 (area 3)
Gi0/0/0 10.12.0.1/24 <-> Gi0/0/0 10.12.0.2/24   Gi0/0/0 10.23.0.3/24 <-> Gi0/0/0 10.34.0.4/24
Gi0/0/1 192.168.1.1/24   Gi0/0/1 10.23.0.2/24     Gi0/0/1 10.34.0.3/24     Gi0/0/1 192.168.4.1/24
```

```
r1# show ip route
O   10.23.0.0/24   [110/2] via 10.12.0.2, GigabitEthernet0/0/0
O   10.34.0.0/24   [110/3] via 10.12.0.2, GigabitEthernet0/0/0
O   192.168.4.0/24 [110/4] via 10.12.0.2, GigabitEthernet0/0/0
r1# ping 192.168.4.1
!!!!!   Success rate is 100 percent (5/5)
```

That last row is a path from area 1 into area 2 and then into area 3 — **two area boundaries**, through
two routers that are each an ABR of two non-backbone areas. A real box has no such route: an ABR not
attached to the backbone does not inject type-3 summaries into non-backbone areas, so r1 would know
nothing about 192.168.4.0/24. Here it is installed, and its metric `4` is the sum of every link along
the path, exactly as if the areas were one broadcast domain.

**The console already knows the box is an ABR.** In the same run, `show ip ospf` prints:

```
r2# show ip ospf
Routing Process with ID 2.2.2.2
  Areas: 1, 2
```

(`engine/cli.js:5462-5464` builds that list from the interfaces' own areas), while the route table
beside it prices area 3 as an extension of area 2.

**`IA` is a legend entry with no emitter.** `IP_ROUTE_CODES_LEGEND` prints
`IA - OSPF inter area` (`engine/cli.js:607-617`), transcribed from the vendor block; a grep of
`engine/` for a route carrying that code returns nothing. The code a row prints is also hardcoded:
`routesTable()` writes `code: 'O'` for every entry of `ospfRoutes` (`engine/device.js:1386-1391`),
ignoring any `code` a route object might carry, so fixing the engine alone would still print `O`.
That single function is what the inspector reads too, which is why `test/routes-agreement.test.js`
can pin both surfaces to it.

**The docs disagree with each other and with the code.** `docs/SIMULATION.md:395` advertises the
"ABR pattern", and `engine/ospf.js:10-21` lists as a deliberate simplification "one area per link …
(no virtual links, no ABR route leaking)" — the second sentence is false at this tree: routes leak in
both directions through every ABR, they just keep the `O` code.

## What is missing or weak, ranked

1. **Areas are not an SPF boundary.** One graph over every area means a path can transit any number
   of areas, and a destination's cost is the whole path rather than the ABR's advertised distance.
   This is the defect the plan exists to remove; everything below follows from it.
2. **The backbone rule is absent.** r2 (areas 1, 2) and r3 (areas 2, 3) have no interface in area 0
   and still exchange every prefix across their boundaries (measured above). On a real box, an ABR
   without a backbone interface injects nothing, so a three-area lab like this one is unroutable by
   design — a lesson the model currently cannot teach.
3. **`IA` can never be produced or printed.** Three hardcoded `'O'`s (engine `:661`, simulator loop,
   `device.js:1386`) and no summary representation to hang the code on.
4. **Area preference is not modelled.** RFC 2328 §11 ranks intra-area above inter-area at *any*
   cost; the merge keeps the cheapest row (`engine/ospf.js:572` `betterRoute()`,
   `engine/simulator.js:1670-1700`), so an inter-area shortcut outranks a longer intra-area path.
5. **Two derivations of the same rows.** `routesFromSpt()` and the simulator's own loop must be
   changed together or the engine and the console will disagree about the same topology — the drift
   class `test/routes-agreement.test.js` exists to catch, one layer down.
6. **No LSA model at all** — no type-3 database, no `show ip ospf database`, no `area range`. Named
   here so the plan is not read as "multi-area OSPF is finished"; none of it is proposed.

## Ordered steps

| # | step | size |
|---|---|---|
| 1 | Research capture, `research/ospf-inter-area.md`: RFC 2328 §11 (path preference), §12.4.2 (summary-LSAs and the backbone requirement), §16.2 (inter-area calculation), plus one vendor transcript of `IA` rows and of an ABR with no backbone interface. Sources only, no code. | S |
| 2 | Area-scoped SPF: a new `spfInArea(graph, rootId, area)` beside `spf()` (do **not** change `spf()`'s contract — `test/ospf.test.js:78-104,335-341` calls it on a bare graph), and `computeOspf()` runs one SPT per area the root has an interface in. Intra-area routes stay `O` with today's numbers; the whole-path-across-areas rows disappear. | M |
| 3 | Summary injection and the `IA` code: an ABR (interfaces in ≥2 areas, one of them area 0) advertises each destination it knows in area X into area Y at its own distance, and the row carries `code: 'IA'`; `routesTable()` prints `r.code || 'O'` so the console and the inspector both read it. Cost comes from the ABR's distance **plus** the stub, never from the root's SPF distance. | M |
| 4 | The backbone rule: an ABR with no area-0 interface injects nothing, and a router never installs a row that would transit a non-backbone area. This is the step that changes existing lab answers (see Risks) and is **needs Jay's approval**. | S |
| 5 | Preference: intra-area beats inter-area at any cost before the cheapness merge in `betterRoute()` and the simulator's `seen` loop. One comparison, exercised by a lab where the inter-area path is shorter. | S |
| 6 | One derivation: `computeOspf()` consumes `ospfLib.routesFromSpt()` (with a small adapter that resolves next hops to neighbour IPs and interface names) and its private loop at `engine/simulator.js:1646-1700` is deleted. No behaviour change on its own; it is what keeps steps 2-5 from landing twice. | M |
| 7 | Bookkeeping: `docs/SIMULATION.md:395` states what an area boundary now does and does not do, `:397` keeps the Approximate row honest, the `engine/ospf.js:10-21` header loses "no ABR route leaking" and gains the two-area rule, `docs/CLI.md:243,1896` mention `IA` and the backbone requirement, legend unchanged. | S |

## Risks

- **The backbone rule breaks labs that are wrong today.** Every straight-line three-area lab loses
  its far-side routes at step 4; each PR must quote before/after `show ip route` for the two probes
  below, and the receipt must say the routes were never valid, not that they were "optimised away".
- **`IA` is two characters in a one-character column.** `show ip route` rows are column-pinned
  (`test/show-ip-route.test.js`, `show-ip-route-codes-legend.test.js`); widening the code field will
  move every row, so step 3 must measure the vendor column (`IA ` is written with a trailing space in
  IOS output) instead of guessing at a pad function.
- **A summary re-advertised into the area it came from is a loop.** Split horizon for type-3 is the
  easy thing to forget; the diamond probe in the test plan exists to catch it.
- **The root's distance is not the summary's cost.** In the straight-line lab above the two numbers
  coincide (1 + 1 + 1 + stub), so a worker who computes metrics from the root's SPT will pass the
  obvious test and fail a diamond. Step 3's test must use a topology where the ABR's path to the
  prefix is longer than the root's glued path.
- **`spf()` is a public export** (`engine/index.js`) and `test/ospf.test.js` calls it directly with a
  bare two-area graph; changing its return shape to "per area" would silently break that suite, which
  is why step 2 adds a sibling function rather than redefining the old one.
- **Two `O` literals remain if step 6 is skipped**: the simulator loop keeps installing rows that
  `routesTable()` labels `O`, so step 3's code change would look applied and print nothing.

## Test strategy

New `test/ospf-inter-area.test.js`, built like `test/ospf-adjacency-link-state.test.js` (catalog
spec, `Topology`, `runCommands`, `sim.computeOspf()`):

1. the four-router lab above: r2 and r3 have no area-0 interface, so r1 installs **no** route to
   192.168.4.0/24 and a ping fails with "no route";
2. add a cable from r2 into a fifth router in area 0, recompute: r1 now reads
   `IA 192.168.4.0/24 [110/n] via …` with `n` equal to r2's own distance plus the stub, and `IA`
   appears in the code column of both the console row and the inspector row;
3. an intra-area prefix beside an inter-area prefix **in the same area**: the intra-area row wins at a
   higher cost (RFC 2328 §11), and the loser is not installed;
4. a diamond where the ABR's distance to the prefix is 5 and the glued distance would be 3: the row
   reads 5+stub, not 3+stub;
5. `show ip route` still prints `O` for a prefix inside the router's own area, and the legend is
   byte-identical (`test/show-ip-route-codes-legend.test.js`).

Regression set: `test/ospf.test.js`, `ospf-area-id`, `ospf-route-metric`, `ospf-adjacency-link-state`,
`ospf-priority`, `ospf-timer-mismatch`, `ospf-wire`, `show-ip-route.test.js`,
`show-ip-route-codes-legend.test.js`, `routes-agreement.test.js`, `route-selection.test.js`,
`protocol-regression.test.js`, then `npm test`. Docs step runs `node scripts/check-doc-citations.js`.

## Issues this would close

None. The queue holds one device request (#130, the UDW-PRO) and no open issue about OSPF. The plan
removes a route a real box would not install and makes the `IA` line of a copied legend reachable.

## Deliberately left out

Stub, totally-stubby and NSSA areas; virtual links; `area <id> range` summarisation; OSPF
authentication; NBMA/point-to-multipoint network types; external LSAs and redistribution (the
roadmap's separate absence); the DR election and adjacency FSM (already modelled, Approximate in
`docs/SIMULATION.md:397`); and `show ip ospf database`, which needs the LSA model this plan does not
build.
