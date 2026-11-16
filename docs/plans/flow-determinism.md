# Plan: one question, one answer — a flow's verdict, and the state it reads

Status: forward plan, no code. Answers #1518, whose headline claim does **not** reproduce on
`bfc4f2ea` (see "Measured"), and whose "better fix" would contradict a documented decision.
Touches `engine/simulator.js`, `engine/device.js`, `server/index.js`, `test/`,
`docs/SIMULATION.md` §Approximate.

## What exists today

Run state is on the `Device`, inside the `Topology`, and outlives every `Simulator`:
`macTable` (VLAN 1), `macTables` (per vid), `arp`, `arpSeenAt`, `arpPorts`, `pending`
(`engine/device.js:187-201`). `Simulator.reset()` (`engine/simulator.js:185-230`) rewinds the
run and deliberately leaves them alone. `docs/SIMULATION.md:66-76` states this as a choice —
"so it persists across runs — which is what a real box does" — and names two tables that age:
`MAC_AGE_MS` = 300 s (`engine/device.js:6`) and `ARP_AGE_MS` = 4 h (`:12`).

**Ageing needs an instant, and the default run has none.** `arpLookup(ip, now)` only ages when
`now` is finite (`engine/device.js:315-322`), and `_nowMs()` (`engine/simulator.js:4275-4277`)
returns `null` whenever `runAtMs` is not finite — which is the default, `Infinity`
(`:176`). `macLookup` takes the same `_nowMs()` (`:3284`, `:3387`), so the same holds for the
bridge table. The documented 300 s and 4 h expiries therefore cannot fire on the path the
console, the API and the browser use.

**`pending` is swept by whichever run happens to end.** `_run()` calls `_sweepPending()` on
every exit (`:2911`), and that walks **every** device in the topology and clears its list
(`:2961-2974`). A run therefore reports — and erases — in-flight state it did not create.

**A flow's refusal is computed by its own table, not the ranked one.** `_flowFailure()`
(`:3764-3795`) tests acl-deny, no route, PoE, VLAN, STP, NAT, then falls back to
`E_UNREACHABLE`. `ping` and `traceroute` use `_lastDiscard()` (`:2922`), which ranks "peer port
shut" above "no ARP reply from" above silence (`:666`, `:767`; #1431, #1445).

**`openFlow` takes no `atMs`.** Its options are `proto, srcDevice, dstDevice, dstIp, srcPort,
dstPort, bytes` (`:3826-3840`); `ping` accepts `atMs` (`:422`, `:587-600`) and the endpoint
forwards it (`server/index.js:1210-1224`). A flow is always asked at the settled instant.

### Measured on `bfc4f2ea`, 2026-11-16

Repro harness: build a topology in-process, `new Simulator(topo)`, one `openFlow`. Thirteen
shapes — pc-sw-srv; two switches with VLAN 10; destination added before source; pc-sw-r-sw-srv;
hosts behind a switch SVI; DHCP-addressed client; router-on-a-stick; switch SVI as destination;
reverse direction first; UDP; a two-member LAG; a `serialize()` then `fromJSON()` round trip;
and three identical rebuilds — every well-formed shape returned `ok: true` on its **first**
flow. The title claim of #1518 ("always fails `E_UNREACHABLE`") is not reproducible on `main`.

Two things are reproducible:

* SRV's switch port shut, then one ping and one flow asked on the same board. `ping`:
  `success=false`, `reason: "peer port shut (d2 Fa0/2) (dropped by d3)"`. `openFlow`:
  `code: E_UNREACHABLE`, `reason: "no response from 10.0.0.80:80"` — while its own timeline's
  first discard is `peer port shut (d2 Fa0/2)`. Same question, two answers, and the flow's is
  the one #1431 removed from ping.
* After a live ping on a settled lab, `dev.arp` holds `10.9.0.80 → 02:00:00:00:01:00` and
  `dev.arpSeenAt` is **empty**; every `macTable` entry reads `{port, atMs: null}`. A neighbour
  learned by a real reply is indistinguishable from "an entry that nothing dated — written by a
  fixture — never ages", which `docs/SIMULATION.md:73-74` offers as the exception.

## What is missing or weak, ranked

1. A flow reports its refusal from a private list, so a dead port reads as silence.
2. Learned state is undated on the default instant: the two TTLs the docs advertise never fire.
3. A flow cannot be asked at an instant, so a converging board and a settled one are asked the
   same question and cannot be told apart — the ambiguity #1518 is really about.
4. No test asks one question twice, or asks it of a reloaded copy of the same board.
5. State ownership itself (`Device` vs `Simulator`) — the issue's "better" fix, which
   `docs/SIMULATION.md:66` argues against. Last, conditional, largest.

## Ordered steps

1. **S — a determinism suite.** `test/one-answer-per-question.test.js`: the same flow asked
   twice on one board, on a fresh `Simulator` over the same `Topology`, and on a
   `serialize()`/`fromJSON()` copy must return the same `{ok, code, reason, hops}`; the same for
   a ping; and once more after an unrelated ping and after `POST /reset`. Pin the thirteen
   shapes above as "first flow is ok" so the issue's headline claim cannot come back silently.
   This is the net #1518 asked for, and it is what decides whether steps 2-4 are needed.
2. **S — a flow reports the reason the timeline shows.** `_flowFailure()` asks `_lastDiscard()`
   for the ranked sentence before falling back to `E_UNREACHABLE`; keep its ACL / no-route /
   PoE precedence over the sweep's conclusion. Regression tests for shut port, down link and
   unanswered ARP, asserting the flow and the ping print the **same** sentence. No doc quotes
   `no response from` today, so nothing outside `web/` and `test/` moves.
3. **M — date what was learned.** Decide the settled lab's clock once (a `Topology`-level
   instant derived from `lastChangeAtMs`, or `runAtMs` defaulting to the board's age) so
   `arpLookup` and `macLookup` receive a finite `now` and `MAC_AGE_MS`/`ARP_AGE_MS` can fire;
   tests at ±1 s around each TTL, plus a case proving a fixture-written entry (no `atMs`) still
   never ages. If Jay prefers the opposite answer — no ageing without a named instant — then
   `docs/SIMULATION.md:69-74` and `docs/CLI.md` must stop advertising TTLs instead.
   **Needs Jay's approval: which clock.**
4. **S — let a flow be asked when.** `openFlow({ atMs })` sets the run's instant the way `ping`
   does, and `POST /api/topologies/:id/flows` forwards `atMs` with the validation of
   `server/index.js:1210-1224`. Test: a flow at a converging instant either converges or is
   refused with the converging sentence, but never silently answers as a settled board.
   **Needs Jay's approval: new API field.**
5. **L — only if 1-4 still leave a divergence.** Move per-run state off the `Device` onto a run
   object owned by the `Simulator`, with an explicit carry-over set (flows, DHCP leases, NAT
   translations) — 134 references to `arp`/`macTable`/`pending` across `engine/`, `server/` and
   `test/`. `docs/SIMULATION.md:66-76` moves in the same PR, and only after step 1 shows a
   divergence it cannot explain.

## Risks and test strategy

* Step 2 changes visible refusal text: `web/` renders `reason` verbatim and `test/` holds
  refusal-string assertions; grep both before landing. Keep the code `E_UNREACHABLE` unless the
  ranked reason maps to a better one — the sentence is the fix, not the code.
* Step 3 changes what `show arp` and `show mac address-table` print on a long-lived board, and
  can expire entries mid-session. Land it with the CLI suites green and a note in
  `docs/CLI.md` §"Reading `show arp`" (`:1335`).
* Step 4 is additive: no `atMs` keeps today's meaning (settled), so no current caller changes.
* Every step is one PR, its own tests, `npm test` green, no workflow edits.
* `_sweepPending()`'s whole-topology clear (`:2961-2974`) is left alone here; if step 1 shows a
  cross-run discard attributed to the wrong run, it becomes its own S step rather than being
  folded into step 2.

## Deliberately left out

`POST /reset` clears three of the six tables a device keeps — `macTable`, `arp`, `pending`
(`server/index.js:1378`) and not `macTables`, `arpSeenAt`, `arpPorts` or `pending6`
(`engine/device.js:187-201`; `pending6` created at `engine/simulator.js:1854`). Nothing measured
today fails on it — on the settled path those maps are empty — so it belongs with whichever PR
first populates them. Also not here: the bind/Origin/auth work in
`docs/plans/server-exposure.md`, and #1596/#1586, which are ping wording already in flight.

## What this would close

#1518 (steps 1-3), and it retires both shapes of its complaint: a flow that fails for a stated
reason instead of silence, and a board whose history is visible in what it remembers.
