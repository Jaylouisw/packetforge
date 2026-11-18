# Plan: the interface counters accumulate forever, and the console has no `clear counters`

Status: forward plan, no code. Measured on `e52dde9d`, 2026-11-18. Closes no open issue - the queue is five
blocked device requests (#130, #803, #807, #808, #810), none about the console. Steps 1-3 add one EXEC
command and one signpost line and change no existing number; step 4 touches the HTTP API and is
**needs Jay's approval**.

`docs/CLI.md:647` makes the promise this plan is about: counters "accumulate over every run against that
topology, like real interface counters - a second `ping` adds to the first". Every property of that sentence
holds except the one that makes real interface counters usable: on a box, `clear counters` zeroes them. Here
the only reset is a brand-new topology, so the number an operator reads after fixing an ACL is the traffic
from before the fix plus the traffic after it, with nothing to say which is which.

## What exists today

| fact | evidence |
|---|---|
| one port's tally, and its shape with nothing counted | `emptyPort()` `engine/flow.js:382` - `packetsIn/bytesIn/packetsOut/bytesOut`, four transport fields, `drops {total, byReason}` |
| read side: a missing row already reads as a truthful zero | `portCounters()` `engine/flow.js:516` returns `c.ports[String(port)] \|\| emptyPort()` |
| what the API publishes | `counterSnapshot()` `engine/flow.js:403` -> `runtime[id].counters` at `server/index.js:404`, `:1293`; `counted` distinguishes "no row" from "zero" |
| what the console prints | the two lines at `engine/cli.js:5914-5915`, drop summary at `:5919`; the view starts at `:5794` |
| the console's only reader | `Simulator.portCounters(devId, port)` `engine/simulator.js:1151` |
| the one reset that exists | `resetFlowState()` `engine/flow.js:366`, called from `server/index.js:1440` when a topology replaces its flow state - it wipes flows, counters and the id allocator together |
| no `clear` word, no arm for one | `EXEC_WORDS` `engine/cli.js:76-89` is enable/configure/converge/show/ping/link/links/traceroute/exit/logout/quit/help; the dispatch chain at `:769` has no `clear`; `_help()` `:6309` lists what exists |
| no prompt machinery to print `[confirm]` with | `CliSession.run()` takes one line and returns output; `grep -n "pendingPrompt\|needsConfirm\|awaiting" engine/cli.js` finds nothing |
| the guards already in place | `test/counters-agreement.test.js` (console == payload, port by port, reason by reason), `test/interface-counters.test.js`, `test/counter-payload.test.js` |
| how hot this code is | last touched by #1428 (2026-11-11); before that #1330, #1258, #1252 - four additive fixes |

## What is missing, ranked

1. **Nothing zeroes a tally.** The only reset is a new topology (`flow.js:366` via `server/index.js:1440`).
   After a cable move, an ACL fix or a second `ping` used as a control, the block mixes both runs, and
   `docs/CLI.md:647`'s "like real interface counters" is the one property it does not have.
2. **The view that prints the number never says how to zero it**, and `help` has no `clear` word. Every other
   companion command in this repo signposts itself - the `show interfaces <port> counters errors` refusal at
   `engine/cli.js:443` names the two forms that do work - so a reader of this block has nowhere to go.
3. **No client can zero them.** `runtime[id].counters` is read-only (`server/index.js:404`, `:1293`).
   `web/app.js` does not read counters yet (`test/counters-agreement.test.js:9`), so this is debt to pay
   before a UI can offer the same act the console will have.
4. Not in this plan: the tally has no *epoch* and no rate. Both are new surface; see "left out" below.

## Steps

**1. Engine: remove one port's tally (S).** `clearPortCounters(state, devId, port)` in `engine/flow.js` beside
`portCounters()` (`:516`): `delete counters[devId].ports[String(port)]`, returning whether a row was there.
*Delete, do not write `emptyPort()`*: the documented payload rule is that a port which has counted nothing is
absent from the payload (`docs/CLI.md:681`), and `portCounters()` already answers `emptyPort()` for a missing
row - so deleting keeps the payload exactly as documented and the console's output unchanged in shape.
`Simulator.clearPortCounters(devId, port)` beside `:1151`. New `test/counters-clear.test.js`: the cleared port
reads zero, its siblings are untouched, the device totals are untouched (they are flow accounting, not
interface accounting - `countPacket()` comment `engine/flow.js:467-495`), the payload row is gone, and the
console prints `0 packets input` rather than `counters: not measured`.

**2. Console: `clear counters [<port>]` (S).** `{ word: 'clear', spellings: ['clear'] }` in `EXEC_WORDS`
(`:76`), one arm in the chain at `:769` beside `ping`, the port resolved by `resolvePortName` so every
spelling works (`:1324` is the existing pattern). Bare `clear counters` clears every port; a name that matches
nothing is refused by name with the sentence the other views use (`% No interface ...`, `:4376`). Then
`_help()` (`:6309`) and the counters section of `docs/CLI.md`. The acknowledgement names what was cleared.
Depends on step 1.

**3. Signpost the view (S).** The `show interfaces` block says how to zero what it printed, in the voice of the
`counters errors` refusal (`viewAfterPort()`, `:443`), and `docs/CLI.md` gains the sentence. Small, but this
repo's rule is that a printed number which cannot be acted on is a dead end.

**4. API: let a client zero them (S/M) - needs Jay's approval.** `DELETE /devices/:id/counters[/:port]` (or
`POST .../counters/clear`) calling the same `Simulator.clearPortCounters`, so the console and a future UI
cannot diverge. No new state, no new payload field, an unknown port refused in the existing error shape.
Depends on step 1.

## Risks

- **The clear is the board's, not the session's.** `flowState` is per topology and every endpoint shares it
  (`server/index.js:1083`), so one session's `clear counters` is visible to every other reader of that lab.
  That is the right semantic - the counters belong to the topology - but it is exactly what a per-session
  mental model gets wrong, so it goes in the docs and in a test.
- **Device totals and port rows will disagree after a clear, by design.** `countDrop()` (`:538`) increments
  both `c.drops` and the port's own `p.drops`, and `c.drops` is published by `counterSnapshot()`. Clearing a
  port removes its row but not the device total. Step 1 accepts and documents that (the device totals are the
  flow question, not the interface question). Recomputing device totals from the rows is the alternative and
  touches every counter consumer plus the agreement suite's arithmetic - its own PR, and not proposed here.
- **The agreement suite is the gate.** `test/counters-agreement.test.js` requires console and payload to agree
  port by port and reason by reason, including across the catalogue sweep. A cleared port must be absent from
  both, never printed by one and missing from the other.
- **A real box asks `[confirm]`.** This console has no prompt state (table above), so the command will act at
  once. Saying so in the acknowledgement is the honest option; prompt machinery is a much larger change that
  would touch every view, and is not proposed here.

## Test strategy

`test/counters-clear.test.js` for the engine rule and the console line (sibling ports, device totals, payload
absence, unknown port). One clear folded into `test/counters-agreement.test.js`'s sweep. `node
scripts/syntax-check.js`, then the full `npm test` - `engine/cli.js` and `engine/flow.js` are shared code.
Pasteability: the acknowledgement and the new `help` line must be typeable back into the session that printed
them.

## Deliberately left out

Rates and an epoch (`Last clearing of ... counters never|<instant>`): the only clock is the simulation's
`runAtMs` (`engine/simulator.js:435`), which is `Infinity` unless a run pinned an instant, so an epoch line
would print "never" for the ordinary session - that needs a decision, not a formatting fix. Also left out: the
MTU/bandwidth header lines a box prints above the counters (the model holds `this.mtu = 1500` at
`engine/device.js:90` and nothing prints or sets it), the `[confirm]` interaction, and the sibling clear
families (`clear mac address-table dynamic`, `clear ip route *`) which each need their own ageing semantics.
