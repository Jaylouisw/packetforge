# Plan: IPv6 is routed and pingable, and the console can show one thing about it

Status: forward plan, no code. Measured on `62a29cd2`, 2026-11-20, with a probe lab built directly on
`Topology`/`Simulator`/`runCommands` (a `generic-router` and a `generic-pc` on one cable, `2001:db8:aa::1/64`
and `::2/64`, one static `ipv6 route`, one autoconfig host). Closes **no** open issue - the tracker holds
**0 open issues** at 2026-11-20T00:37Z (five open PRs, none about IPv6; #1980 is a changelog plan). Steps 1-4
read state the engine already keeps. Steps 5-6 add ICMPv6 error messages, which `docs/SIMULATION.md:293`
declares absent today: that is new protocol surface, so those two **need Jay's approval**.

IPv6 arrived as a forwarding path, and the path is real: a host autoconfigures over ND and SLAAC and pings a
router 5/5. What arrived with it is exactly one read-only view - `show ipv6 nd` - and the two questions an
operator asks when a ping fails have no answer at all. The route table is invisible, the neighbour cache is
invisible and cannot expire, the brief table says the port has no address, and `traceroute` refuses an IPv6
literal in a sentence. Measured:

```
show ipv6 ?                -> % `show ipv6` needs a view: this console has nd - what this device would advertise.
show ipv6 route            -> % Invalid show command: ipv6 route
show ipv6 neighbors        -> % Invalid show command: ipv6 neighbors
show ipv6 interface brief  -> % Invalid show command: ipv6 interface brief
show ip interface brief    -> GigabitEthernet0/0   unassigned  YES unset  up  up    (the port holds 2001:db8:aa::1/64)
show interfaces Gi0/0      -> ipv6: 2001:db8:aa::1/64, link-local fe80::ff:fe00:0
show running-config        -> ipv6 address 2001:db8:aa::1/64
traceroute 2001:db8:aa::2  -> % Invalid traceroute target: 2001:db8:aa::2 (this console traces IPv4 paths only)
ping 2001:db8:aa::1        -> Success rate is 100 percent (5/5)
```

The shapes to copy are in the same checkout: `show ip route` (`engine/cli.js:6014`), `show arp` (`:6670`) with
its aged rows (`Device.arpRows()`, `engine/device.js:792`), and the refusal helper `showNoTail()`
(`engine/cli.js:595`).

## What exists today

| fact | evidence |
|---|---|
| IPv6 forwarding works both ways, with real ND and SLAAC | `_forwardL3v6()` `engine/simulator.js:2421`, `_sendL3v6()` `:2042`, `ping6()` `:2446`; measured 5/5 |
| the console reaches echo, and says so | `if (literal6)` `engine/cli.js:4307`, `sim.ping6()` `:4312` |
| route selection exists: connected, static, default, longest prefix | `Device.route6To()` `engine/device.js:1139-1165`; static rows in `config.routes6` `:274` |
| the state is stored and printed only in the config | `engine/cli.js:7047-7053`; the console's own comment there calls the old hole "stored and printed nowhere" |
| a learned default gateway is printed nowhere as a route | `show running-config` suppresses it when `gateway6Learned` (`engine/cli.js:7051`); it appears only as a line in `show ipv6 nd` (`:7421`), on a host, inside the RA view |
| there is exactly one IPv6 view | `showIpv6Usage()` `engine/cli.js:729-731`, dispatch `:6180-6182`, `help` line `:7446` |
| the ND cache is a bare `addr -> mac` map | `_ndTable()` `engine/simulator.js:2028-2031`; three writes: NS `:2113`, NA `:2125`, RA router `:2329`; the only read is `:2044` |
| it has no port, no timestamp, no expiry, no clear | a grep for `nd.delete` or `nd.clear` across `engine/` finds nothing; no `ND_AGE`-style constant exists (measured) |
| IPv4's cache already has all three, and a view over them | `arpSeenAt`/`arpPorts` `engine/device.js:234,238`, `ARP_AGE_MS` `:12`, `arpRows()` `:792`, `show arp` `engine/cli.js:6670` |
| `show ip interface brief` ignores IPv6 entirely | the address cell falls back to `unassigned` from `i.ip` alone (`engine/cli.js:5981`); measured `unassigned` on a port holding a /64 |
| `traceroute` is IPv4 by decision, not by accident | `_traceroute()` `engine/cli.js:4636-4642` returns "this console traces IPv4 paths only" |
| hop-limit expiry is silent on IPv6, loud on IPv4 | `_forwardL3v6()` `engine/simulator.js:2421-2425` emits a `drop` and returns; `_forwardL3()` `:3764` calls `_icmpErrorTo(..., ICMP_TIME_EXCEEDED, 0)` |
| the ICMPv6 type table has no error types | `ICMPV6_TYPES` `engine/ipv6.js:21-28` - echo, RS, RA, NS, NA only |
| `_sendIcmp6` cannot vary the hop limit | `engine/simulator.js:2064`, `hopLimit: 64` hard-coded at `:2096` |
| both absences are already documented | `docs/SIMULATION.md:272` (ND ageing), `:293` (ICMPv6 errors) |
| every documented `show` form is typed at a router and a switch | `test/docs-show-commands.test.js:10-19` (62 forms, 124 commands) |
| the help index is pinned in both directions | `test/help-completeness.test.js:1-18` |
| the browser has no command list to update | `grep -rn "show ipv6" web/ server/` returns nothing (measured) |

## What is missing, ranked

1. **No IPv6 route table.** A static route that loses to a longer connected prefix, and a default gateway
   learned from an RA (#1463's subject), are invisible outside `show running-config` - and the learned gateway
   is invisible even there. This is the first question after "the ping failed at the second hop".
2. **No neighbour table, and a cache that cannot be wrong out loud.** `dev.nd` holds a MAC and nothing else:
   no port ("which cable is this neighbour on", the question #1253 answered for ARP), no age, no expiry, no
   way to clear it. A host swapped on the same cable keeps its old MAC for the life of the topology.
3. **`show ip interface brief` denies the address.** The one table an operator opens first prints `unassigned`
   on a port that holds a global IPv6 address (measured above).
4. **Hop-limit expiry is a silent drop.** The packet that a v6 traceroute depends on is thrown away without an
   ICMPv6 type 3, so a loop looks like a black hole and no v6 trace can be built on this engine at all.
5. **`traceroute` refuses an IPv6 literal in a sentence.** With (4) fixed, it is the second diagnostic an
   operator already knows, one branch away.

## Ordered steps

1. **S - `show ipv6 route`.** Read-only view over `route6To()`'s inputs: `C` for each prefix in `ip6Addrs()`,
   `L` /128 per address, `S` for each `config.routes6` row, `S ::/0` for `config.gateway6` with
   `(learned from a router advertisement)` when `gateway6Learned` - the provenance `show ipv6 nd` already
   prints at `engine/cli.js:7421`, moved where a route is read. A device without `isL3()` gets the sentence
   `show ip route` uses for a switch (gateway-not-set shape), not `% Invalid show command`, because
   `test/docs-show-commands.test.js` types the form at a switch too. Touch: dispatch `engine/cli.js:6180`,
   `showIpv6Usage()` `:729`, `_help()` `:7446`, `docs/CLI.md` IPv6 table (`:683`), new
   `test/ipv6-route-view.test.js`.
2. **S - `show ipv6 neighbors` over the cache that exists.** Columns Address / Age / Link-layer Addr /
   Interface, rows sorted by address. The port is not in the map: add `ndPorts` beside it, written at the
   three fill sites (`engine/simulator.js:2113,2125,2329`) exactly as `arpPorts` is written at
   `engine/device.js:359-360`, and leave `dev.nd` itself untouched so `_sendL3v6`'s read at `:2044` cannot
   change. Age prints `-` here - no timestamp exists yet, and inventing one is worse than the dash (#1397's
   rule for `show arp`). No `State` column until step 3 gives it a meaning.
3. **M - make the cache ageable, and clearable.** `ndSeenAt` + `ND_AGE_MS = 14400000` (IOS's
   `ipv6 nd cache expire` default is 14,400 s), `Device.ndRows(topo, nowMs)` modelled on `arpRows()`
   (`engine/device.js:792`), `State` = `REACH` inside `ND_DEFAULTS.reachableMs` (`engine/ipv6.js:30-33`,
   30,000 ms) and `STALE` after, and a new EXEC `clear ipv6 neighbors`. The view from step 2 now reads
   `ndRows()`; a stale gateway MAC (the RA write at `:2329`) disappears instead of black-holing traffic.
   `docs/CLI.md` gains the `clear` row and the `State` column; `test/help-completeness.test.js`'s list gains
   the command in the same PR.
4. **S - the brief cell stops lying.** When `i.ip` is absent but the port holds a global address, print the
   compressed form (`ipv6.formatIpv6`) in the IP-Address cell; `unassigned` only when neither family exists.
   Keep the 16-wide cell: `briefLine()` appends a space rather than truncating (`engine/cli.js:341-350`), so a
   39-character address shifts the row - print the first global address and say so in the docs rather than
   cutting a name (the rule `briefLine`'s own comment states). Do not print a link-local: every port has one,
   and every row would stop saying anything. Touch: `engine/cli.js:5981`, `docs/CLI.md` brief section,
   new `test/ipv6-brief-address.test.js`.
5. **M - ICMPv6 errors exist (needs Jay's approval).** Type 3 code 0 on hop-limit expiry and type 1 code 0 on
   no route, added to `ICMPV6_TYPES` (`engine/ipv6.js:21-28`), emitted by `_icmp6ErrorTo()` quoting the
   invoking packet (RFC 4443 §4.2) from `_forwardL3v6()` (`engine/simulator.js:2421-2434`), and collected in an
   `icmp6Errors` array mirroring `icmpErrors` (`:215`). No CLI change; `docs/SIMULATION.md:293` moves from
   Absent to Modelled in the same PR. `test/icmp6-errors.test.js` reads the frame, not the event.
6. **M - `traceroute <ipv6>` (needs Jay's approval, follows step 5).** `_traceProbe6()` mirroring
   `_traceProbe()` (`engine/simulator.js:818`) - which needs an `opts.hopLimit` on `_sendIcmp6`
   (`:2064`, hard-coded `64` at `:2096`) - and `Simulator.traceroute6()` mirroring `traceroute()` (`:754`).
   The CLI drops the refusal at `engine/cli.js:4642` and routes a v6 literal to the new method; `hopNumberField()`
   and `probeCells()` (`:868-880`) are protocol-agnostic and are reused, so the hop line cannot be spelled two
   ways. Docs: the `traceroute` row (`docs/CLI.md:44`) gains one clause, and `test/traceroute-ipv6.test.js`
   asserts the same three-probe hop line over ICMPv6.

## Risks and test strategy

* **Do not change the shape of `dev.nd`.** `_sendL3v6()` reads it on every packet (`engine/simulator.js:2044`).
  Parallel maps (`ndPorts`, `ndSeenAt`) are the ARP precedent and keep the forwarding path byte-identical.
* **Determinism.** Sort rows by `ipv6ToBigInt()`, not by string: `::10` sorts before `::9` as text. The
  flow-determinism plan is the same rule applied to verdicts.
* **Ageing breaks pings that used to pass** after a long `ping ... at` instant. The next send re-resolves with
  an NS, so step 3's suite must cover both a cache hit and a re-resolve, and the RA-gateway swap.
* **The docs are executable.** `test/docs-show-commands.test.js` types each documented form at a router and a
  switch and fails on `% Invalid show command`; a doc row without its handler is a red suite. Its filler maps
  `<address>` to `10.0.0.1` (`:59`), so document `show ipv6 route` with no placeholder.
* **Help is pinned both ways** (`test/help-completeness.test.js`): a new dispatch branch without a
  `showIpv6Usage()` row and a `_help()` line is a failure, not an omission.
* **Column drift is a known bug class here** (#1521): assert the IPv6 brief row against the header by column
  index, not by substring.
* **Left alone on purpose:** `show ipv6 route` prints no administrative distance because `route6To()` has none
  (`docs/SIMULATION.md:292`, Approximate). Printing `[1/0]` there would invent a ranking the code does not do.

## Deliberately left out

* **OSPFv3, MP-BGP for IPv6, IPv6 ACLs, DHCPv6/PD, DAD, fragmentation** - each is protocol surface with its own
  data model; `docs/SIMULATION.md:272,293` already lists them as absent, and none of them is needed to read the
  table this plan exposes.
* **`show ipv6 interface` / `show ipv6 interface brief`.** `show interfaces <port>` already prints
  `ipv6: <addr>/<len>, link-local <ll>` (measured), so a second per-port view would be two spellings of one
  fact until more v6 state exists.
* **A web inspector panel for IPv6.** `web/` has no command surface to keep in step (measured above); the
  console is the surface this plan repairs.
* **ND reachability detection (NUD)** beyond a `State` column inferred from the clock: probing a `STALE`
  neighbour is a scheduler the engine does not have.

## Closes

Nothing. The queue is empty: 0 open issues, 5 open PRs, none about IPv6. The precedents this plan follows -
#1461 (ping accepted an IPv6 literal), #1463 (a learned gateway printed as configured), #1253 (the ARP table's
Interface column), #1403 (a tail answered as though it were the whole table) - are all closed.
