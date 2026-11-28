# Plan: a static route is a statement, and this console stacks copies of it

Status: forward plan, no code. Measured on `d6b1b15a`, 2026-11-28, with one `ISR 4331`
(`GigabitEthernet0/0/0` 10.0.0.1/24, no cable) driven through `runCommands`/`CliSession`.
Closes **#1657** (*"A static route typed twice is stored twice, and the second row says it lost to itself"*).
No step needs Jay's approval: refusing a route that is already configured, and removing the one route a
`no` line names, are what every IOS box does. Boundary with `docs/plans/default-route-selection.md`:
that plan asks *which* route wins and whether the data plane agrees; this one asks *how many rows exist*
and what a `no` line takes away.

## What exists today

Measured, not inferred:

```
r1(config)#ip route 10.9.0.0 255.255.0.0 10.0.0.254
Route added: 10.9.0.0/16 via 10.0.0.254
r1(config)#ip route 10.9.0.0 255.255.0.0 10.0.0.254
Route added: 10.9.0.0/16 via 10.0.0.254
r1#show running-config
 ip route 10.9.0.0 255.255.0.0 10.0.0.254
 ip route 10.9.0.0 255.255.0.0 10.0.0.254
r1#show ip route
S   10.9.0.0/16 [1/0] via 10.0.0.254  (down: no cable)
S   10.9.0.0/16 [1/0] via 10.0.0.254  (down: no cable)  (not installed: the S route for this prefix has distance 1)
```

**Store.** `ip route` builds `{dest, mask, gw, iface, distance?}` and pushes it unconditionally
(`engine/cli.js:2424-2430`). Nothing compares it with a row already held. `ipv6 route` is the same shape at
`engine/cli.js:3634-3645` (`config.routes6.push(...)`, `:3643`) and answers `IPv6 route 2001:db8:9::/64 via
2001:db8:1::2` twice; `config.routes6` measures 2 entries after two identical typings.

**Print.** Both families print one line per entry, so the duplicate reaches the file:
`engine/cli.js:8823` (IPv4) and `:8535` (IPv6). That is the property `test/config-roundtrip.test.js`
exists to hold ("`show running-config` has to be a config you can paste back", `:1-9`) - and a paste is
exactly how the stack doubles: the printer emits the row it was given, so the second paste adds a third.

**Mark.** `routesTable()` groups rows by `dest/mask` and picks one winner per prefix
(`engine/device.js:1504-1532`); every other row gets `shadowedBy` and the sentence
`(not installed: the <code> route for this prefix has distance <n>)` (`:1531`, `:1544-1551`). Two rows with
every field equal still take that path, so the loser is told it lost to itself, at a price it does not pay.

**Remove.** `no ip route` filters every row matching the words that made the route
(`engine/cli.js:2465-2474`) - correct for a stack, and correct only because the stack should never exist.
`no ipv6 route <prefix>/<len> <next-hop>` does not exist as its own form: it falls into the bare-family
branch at `engine/cli.js:2170-2174`, which sets `config.gateway6 = null`, empties `config.routes6` and prints
`IPv6 routes cleared`. Measured on two IPv6 routes plus a gateway: removing one route left 0 routes and no
gateway. `test/config-completeness.test.js:209-211` passes over this because its case holds exactly one route
and no gateway, and `docs/CLI.md:873` publishes the wipe as the documented behaviour of `no ipv6`.

**Load.** `Device` restores the list as a plain slice (`engine/device.js:1790`, `:1616` on the way out), so a
lab file saved by today's engine carries both rows back into the table - the duplicate survives the save
cycle that the console created it in.

## What is missing, ranked

1. **A route has no identity.** No predicate anywhere says "these two lines are the same statement". This is
   the one that must come first, because the other three ask it.
2. **`no ipv6 route <prefix> <nh>` takes the whole family.** Not just a duplicate problem: one route's undo
   removes every IPv6 route on the box and the default gateway with them, quietly.
3. **The shadow sentence prices a loss that was not decided by price.** Even with duplicates refused, two
   legitimate statics to one prefix at distance 1 (different next hops - two real config lines, since the
   model has no ECMP, `docs/SIMULATION.md:297`) print "has distance 1", which is not the reason the second
   row is not installed. The reason is the tie-break order.
4. **Old labs keep their duplicates.** Nothing normalises `config.routes` on load.
5. **No test asserts "one route, one row".** `test/config-roundtrip.test.js:88` checks the route survived,
   never that a second typing added nothing; no suite types a route twice.

## Ordered steps

Each is one PR by one worker. `S` unless marked.

1. **S - the identity.** One predicate on `Device`, `sameStaticRoute(a, b)` plus a v6 sibling, comparing
   `dest`, `mask`/`prefix`, `gw`, `iface` and the *normalised* distance (`Device.routeDistance()`,
   `engine/device.js:1298`, already returns 1 for an unset field - reuse it so `... 10.0.0.254` and
   `... 10.0.0.254 1` are one route, while a floating static at 200 stays a second row). Co-locate it with
   `routeDistance()` so the two readings of "same route" cannot drift.
2. **S - the IPv4 door.** In the `ip route` branch, after the not-a-local-address and no-next-hop refusals and
   before the push at `engine/cli.js:2427`: if a held row matches, push nothing and answer one line. Wording
   follows the house shape for a receipt that states the outcome (`VLAN 1 ... it already exists (...)`,
   `engine/cli.js:1795`; `% A NAT pool called "x" already exists`, `:6701`):
   `% Route already configured: 10.9.0.0/16 via 10.0.0.254 (distance 200)`. IOS itself is silent here; a plan
   comment must say so, and why the console keeps a receipt: an operator pasting a backup needs to be told the
   paste did nothing, not left to diff two files. Two shapes stay two rows - another next hop, another distance.
3. **S - the IPv6 door, and its undo.** Same refusal in `_ipv6Route` (`engine/cli.js:3634`). Then give the
   `no` form its own branch *before* `:2170`: `no ipv6 route <prefix>/<len> <next-hop>` removes that one row
   and prints `IPv6 route 2001:db8:9::/64 via 2001:db8:1::2 removed` (or `% Route not found`), leaving other
   routes and the gateway alone. Keep the bare `no ipv6` wipe, and re-word `docs/CLI.md:873` to say it is the
   whole-family convenience and that `no ipv6 route` is the per-route form - the doc currently hides the bug
   by describing it as the design.
4. **S - old labs.** Collapse on load where `config.routes` / `routes6` are restored (`engine/device.js:1790`,
   `:1800`), using the step-1 predicate, first-typed wins. No file rewrite: the lab on disk is left alone and
   the box holds one row, so the *next* save writes one line.
5. **S - the sentence.** In `routesTable()`, when `row.distance === best.distance` the note must name the
   tie-break, not a price neither row pays: `(not installed: no ECMP - the S route for this prefix is the one
   the table keeps)`, citing `docs/SIMULATION.md:297`. Gate it on equal distance only; the lower-distance
   sentence is correct and heavily pinned (`test/route-selection.test.js:138-144`,
   `test/static-route-distance.test.js:103`) and must not move.
6. **S - the property.** One new suite (`test/static-route-identity.test.js`) that types a route twice and
   asserts: one entry, one printed line, one table row, and the sentence; plus a case per shape that *must*
   stay two rows. Then extend `test/config-roundtrip.test.js` with "a running-config pasted twice reproduces
   it once" - the property a backup restore actually relies on. Docs: `docs/CLI.md:570-571` gains the refusal,
   `:871` the IPv6 form and its `no`.

## Risks and tests

- **`no ip route` deletes by filter, not by find-one** (`engine/cli.js:2466`). After step 2 a stack cannot be
  created, but a lab loaded before step 4 could still hold one; keeping the filter is the safe side (it
  removes what was there) and costs nothing once duplicates are impossible.
- **Learned routes are not configuration.** `bgpRoutes` and `ospfRoutes` are recomputed per pass and never
  enter `config.routes`, so the predicate goes only at the two `push` sites and the two restore sites - never
  into `routesTable()`'s grouping, or a duplicate-learned-row question gets the wrong answer, and the display
  layer stops printing what the protocol handed it.
- **The normalised distance is a judgement call.** Folding unset into 1 means the printed config keeps the
  first typing's shape (no `1` appears - `engine/cli.js:8823` prints a distance only when one was typed), so
  the file stays byte-identical across the refusal. Say that in the step-2 comment.
- **Phrase-pinned tests.** `test/static-route-own-next-hop.test.js:117` requires `Route removed` and an empty
  list; `test/ip-route-fully-specified.test.js:132-158` pins three `no` forms. Step 3 must not reroute the
  IPv4 filter; step 5 must not touch the lower-distance text.
- **Test strategy:** one suite per step (`static-route-identity`, `ipv6-route-undo`, `route-shadow-tie`), the
  rewritten `test/config-completeness.test.js` IPv6 case carrying two routes so the wipe is caught, and
  `npm test` + `npm run syntax` before merge.

## Intentionally out of scope

ECMP itself (one best route is a modelled limitation, `docs/SIMULATION.md:297`); `tag`, `name`, `track`,
`permanent`, `dhcp` and VRF on `ip route` (each a syntax decision with no transcript in hand, see
`research/static-route-distance.md`); the three-implementations problem in
`docs/plans/default-route-selection.md`, which this plan deliberately does not re-open; and any dedupe of
OSPF/BGP-learned rows, which are recomputed and must be printed as received.
