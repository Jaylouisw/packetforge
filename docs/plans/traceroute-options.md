# Plan: `traceroute` promises a hop limit it never reads, counts probes nobody can change, and cannot trace an IPv6 path

Status: forward plan, no code. Measured on `a6a6ab46`, 2026-11-21. Closes **no** open issue - the queue holds two
blocked device requests (#130, #803) and nothing about the trace. Steps 1-3 are the console's own grammar and are
additive. Steps 4-5 add ICMPv6 error messages and an IPv6 walk to the engine: **needs Jay's approval**.

Related but not duplicated: `docs/plans/mtu-and-fragmentation.md` step 2 gives `ping` a `size`; this plan leaves the
probe's size to that one. `docs/plans/ipv6-visibility.md` covers what IPv6 the console can *show*; this is the one
IPv6 question it refuses to *ask*.

## What exists today

| fact | evidence |
|---|---|
| the walk, and two knobs it already takes | `Simulator.traceroute(srcId, dstIp, opts)` `engine/simulator.js:754`; `opts.maxHops` clamped 1-64, default 30 (`:756`); `opts.probes` clamped 1-10, default 3 (`:757`) |
| the console passes neither | `_traceroute()` `engine/cli.js:5018` reads `tokens[0]` and nothing else; the only call is `this.sim.traceroute(this.device.id, target)` (`:5052`) |
| the index promises the hop limit anyway | `help` `engine/cli.js:8081`: `traceroute\|tracert <address\|name> [max <n>]`; `docs/CLI.md:3944-3948` records the half as "indexed and not implemented" |
| and the word is swallowed, not refused | measured on `examples/lab2-router-two-subnets.json`: `traceroute 10.0.2.2 max 2` prints 30 hop lines (33 lines of output). `... numeric`, `... ttl 1`, `... probes 1`, `... source eth0` each print the same trace, unchanged |
| `ping` refuses strays, and says so | `% Unrecognized "<word>" (ping <address\|name> [<count 1-50>] [at <ms>])` `engine/cli.js:4658`, since #1379 - so the two commands read side by side in one ticket disagree about their own grammar |
| only a test can reach the knobs | `test/icmp-errors-traceroute.test.js:75,95,108,148` call `sim.traceroute(..., { maxHops })`; no console test can, because the console has no syntax for it |
| a hop knows no box | hops are pushed with `dev: null` (`engine/simulator.js:781`, `:789`, `:798`), although `_icmpErrorTo()` emits `dev: dev.id` one frame earlier (`:3917`) |
| a probe carries no size | `const bits = latencyLib.pingFrameBits()` (`engine/simulator.js:769`); `ping` hands the same helper `opts.payloadSize` (`:660`, `:2535`) |
| IPv6 is refused at the console | `engine/cli.js:5031-5032`: `% Invalid traceroute target: 2001:db8::1 (this console traces IPv4 paths only)` |
| and the engine could not answer one anyway | `_forwardL3v6()` decrements `hopLimit` and at `<= 0` emits `{type:'drop', reason:'hop limit exceeded'}` and returns (`engine/simulator.js:2493-2496`); `ICMPV6_TYPES` (`engine/ipv6.js:21-28`) holds 128/129/133-136 only - no time-exceeded (3), no destination-unreachable (1). `docs/SIMULATION.md:296` lists both as absent |

## What is missing, ranked

1. **A documented option that does nothing** (`docs/CLI.md:3944`, `engine/cli.js:8081`). `max` is the one word a
   reader is told to use to shorten a trace, and the engine has taken `maxHops` since the walk landed. The console
   is the only layer that cannot pass it, so a 30-hop wall of stars is printed where two hops were asked for.
2. **Every trailing word is dropped in silence.** `traceroute 10.0.2.2 probe 1` reads as a successful command and
   is not one: `probes` is the option that would turn three columns into one, and the engine already clamps it.
   `ping` was taught to refuse a stray word (#1379); the trace beside it was not.
3. **A hop has an address and no name**, and `numeric` - the word that selects between the two - has nothing to
   select. The box that expired the probe is known when the error is made (`:3917`) and discarded two frames later.
4. **No IPv6 trace, in either layer.** The console refuses a colon literal honestly, and the engine has no ICMPv6
   time-exceeded to send, so a dual-stack lab cannot show the command its IPv6 chapter is built on.
5. **The probe's size is not the operator's** (`:769`), so a trace cannot be aimed at a path MTU - deliberately
   ranked last, because `docs/plans/mtu-and-fragmentation.md` step 2 owns `size` and this plan should follow it.

## Ordered steps

**1. `max <n>` becomes real (S).** Parse `max` in `_traceroute()` beside the target, refuse `0` and `65` in the
console's own sentence (the engine's clamp stays as a belt for API callers, but a clamp is invisible and teaches
nothing), and pass `{ maxHops: n }` at `:5052`. One syntax line for every mistake. Test: the 30-hop trace becomes a
two-hop trace on the same bench `test/icmp-errors-traceroute.test.js` already builds, and `help`'s row is now true.

**2. One grammar line, and a refusal for the rest (S).** Accept `max <n>` and `probes <n>` (1-10, the engine's own
range); refuse anything else in `ping`'s shape - `% Unrecognized "<word>" (traceroute <address|name> [max <n>]
[probes <n>])` - with `ttl` and `probe` named as the words this console spells `max` and `probes`, because a box
takes the singular and a reader will type it. `source`, `timeout` and `size` are refused *with a pointer*, not
accepted and ignored. Same for the repeated form (`max 2 max 3`).

**3. A hop can name the box that answered (S/M).** Carry the answering device into the hop (`dev`) from the
`icmp-error` event's own `dev` (`:3917`) and from the destination for the final hop; print `name (address)` when
that box has a hostname, as `show lldp neighbors` already prints `System Name`, and print the address alone under
`numeric`. Names come from the lab's hostnames, **not** a PTR query - a reverse zone nobody configured must not be
able to change a trace's shape.

**4. ICMPv6 errors: time exceeded and destination unreachable (M - needs Jay's approval).** Add `TIME_EXCEEDED: 3`
and `DEST_UNREACH: 1` to `ICMPV6_TYPES` (`engine/ipv6.js:21`), answer from `_forwardL3v6()` on hop-limit expiry
(`:2493`) and on `no IPv6 route` (`:2500`), and record each in a new `this.icmp6Errors` array shaped like
`icmpErrors` (`:216`). The three rules `_icmpErrorTo()` already enforces carry over unchanged (`engine/simulator.js:3896-3903`):
never about an ICMPv6 error, never to a multicast or unspecified source, only with a routable source and an enabled
egress. A new event type must get a legend sentence in `web/app.js` (`:2715-2717` is where its siblings live) or
`test/event-legend.test.js` fails - that test enumerates the types from `engine/`, by design.

**5. `traceroute6`, and the console dispatch (M - needs Jay's approval).** `Simulator.traceroute6()` mirrors
`traceroute()` (`:754`): probe at hop limit 1..n with the echo identifier/sequence the v4 walk uses, three probes per
hop, `FINAL_DROP`-style reasons preserved, so the two traces cannot describe one path two ways. Then `_traceroute()`
dispatches a colon literal to it (`:5031`), and a name only when the resolver returns an AAAA - if `resolveName()`
cannot, name-to-v6 is its own step and the refusal says which record is missing.

**6. The two SIMULATION rows (S).** `docs/SIMULATION.md:296` flips ICMPv6 errors from Absent to Modelled; `:223`
still says *"Still absent: per-hop latency in `traceroute`"*, which #1755 made false and `:222` already contradicts
in the same table. Both in the PR that touches the behaviour, not a docs sweep of their own.

## Risks

- **Step 4 changes forwarding outcomes.** A packet that used to vanish at hop limit 0 now comes back with a message.
  Nothing pins the silent drop today (`grep -rn 'hop limit exceeded' test/` is empty; `test/ipv6-wire.test.js:114`
  pins only the decrement to 63), so the suite should stay green - but a lab that read the packet log for `drop` will
  read `icmp6-error` instead, which is the point and is worth stating in the PR body.
- **A clamp is not a refusal.** If the console clamps instead of refusing, `max 500` silently traces 64 hops and the
  operator learns the wrong rule. The refusal is the deliverable.
- **Two spellings for one option.** A box says `ttl`/`probe`, this index says `max`/`probes`. Step 2 picks the
  index's pair and *names* the other rather than accepting both, so `help` and the console cannot drift apart.
- **Step 5 is the largest and shares the v6 data path** with `ping6` and RA (7 `ipv6*` suites). Land step 4 alone
  first, prove the error path, then walk it.
- **Hop names must not depend on DNS.** A PTR-based name would make a trace's text depend on a reverse zone, which
  is a second feature and a second failure mode.

## Test strategy

New: `test/traceroute-max-hops.test.js` (shortens a walk, refuses 0/65, one sentence per mistake),
`test/traceroute-option-grammar.test.js` (accepts `probes`, refuses `ttl`/`source`/`size` by name, refuses repeats),
`test/traceroute-hop-names.test.js` (`name (address)`, `numeric`, a hop with no hostname), `test/icmpv6-errors.test.js`
(time-exceeded from the expiring box, unreachable with no route, no error about an error, no error to multicast),
`test/traceroute6.test.js` (per-hop addresses match the v4 path, three columns, a silent hop keeps its reason).

Must stay green: `traceroute-hop-line`, `traceroute-name`, `icmp-errors-traceroute`, `ping-default-count`,
`ping-ipv6`, `ipv6`, `ipv6-wire`, `ra`, `event-legend`, `help-completeness` (it types `traceroute <ip>` at
`test/help-completeness.test.js:197` and asserts the row exists at `:90`), `docs-cli-transcript`.

## Deliberately left out

`source <interface|address>` (needs a source-selection rule the engine does not have - `_traceProbe()` always starts
at `src`), `timeout`/`interval`, `size` (`docs/plans/mtu-and-fragmentation.md` step 2 owns it), UDP probes to high
ports (`!U` already prints, but the probe itself is ICMP), a PTR-based `numeric` distinction, ICMPv6 packet-too-big
and PMTUD (the MTU plan), and ICMPv6 errors for anything but the trace.

## What this closes

No open issue. #130 and #803 are device requests; the two defects here were recorded in `docs/CLI.md` and
`docs/SIMULATION.md` rather than filed, so the PRs should reference this plan and flip those rows.
