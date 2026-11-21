# Plan: the flow table is published to a reader that drops it, and the console has no word for a connection

Status: forward plan, no code. Measured on `e2ac102e`, 2026-11-21, with a three-box probe lab
(`generic-pc` — `generic-router` — `generic-server`, 10.0.1.0/24 and 10.0.2.0/24) and one
`openFlow()` call. Closes **no** open issue — the queue holds five (#2336, #2337, #2338, each
with a PR open, and the two device requests #130/#803). Scope: `engine/flow.js` (one state-word
map and, at the end, one deletion), `engine/cli.js` (`SHOW_VIEW_WORDS` and one `_show` branch),
`web/app.js` (a panel and a form), `server/index.js` (a comment that names a command nobody has),
`docs/CLI.md`, `docs/SIMULATION.md`, `test/ui-render.test.js`, one new suite.

## What exists today

**The conversation is real.** A 4000-byte TCP flow from the probe lab lands `established`, hands
over `4000/4000`, and `flow.describe()` (`engine/flow.js:619`) renders it in one line:

```
ok: true  state: established  segments: 3  pkts: 9  bytesDelivered: 4000
describe() -> tcp 10.0.1.10:49152 -> 10.0.2.80:80
```

Every packet walked the forwarding path a ping walks (SYN, SYN-ACK, ACK, three data segments,
three ACKs), which is what `engine/simulator.js:4178` `openFlow()` exists to guarantee.

**Three API doors, and no other door.** `GET`/`POST /flows` (`server/index.js:1288-1295`) and
`GET`/`DELETE /flows/:id` (`:1342-1350`). `openFlow()` is reached from nowhere else: `grep -n
"flow" engine/cli.js` returns one hit, `flowcontrol` (`:802`), so no console verb opens a
connection. `docs/SIMULATION.md:585` states it as a decision — *"Only an explicit API call does.
`openFlow()` is invoked by the server on `POST /flows`"*.

**The browser is sent the table and does not read it.** `fullState()` puts every record on the
wire, through `describeFlow()` which adds `summary` (`server/index.js:275-283`, `:414-415`).
`grep -n "\.flows" web/app.js` returns nothing. What the browser has is the *event* stream: it
paints `flow-open` / `flow-data` / `flow-close` rows (`web/app.js:2762-2769`) and has a legend
row for `flow-refused` (`:2651`), so a conversation exists in the UI only as lines that scroll
away. The only traffic tool in the interface is the ping form (`web/app.js:2489-2502`).

**The console has no word for a connection.** Measured on the probe lab's console:

```
show tcp            -> % Invalid show command: tcp
show tcp brief      -> % Invalid show command: tcp brief
show tcp statistics -> % Invalid show command: tcp statistics
show sessions       -> % Invalid show command: sessions
```

`SHOW_VIEW_WORDS` (`engine/cli.js:203-217`) has fourteen entries and no `tcp`; the exec table in
`docs/CLI.md:20-50` lists twenty-odd commands and none of them is a connection. And a comment
claims the command exists: *"the same as `show flows` shows it on the console"*
(`server/index.js:414`) — `show flows` answers `% Invalid show command: flows` too.

**A refusal leaves nothing to inspect.** A flow to a closed port was refused on its first SYN (a
RST came back) and left **zero** records in the table (`nothing listening on 10.0.2.80:9999`), because the refused record is
deleted (`engine/simulator.js:4304`, `:4333`). The count survives — `flowsRefused`
(`engine/flow.js:403-419`) — and so does one timeline row (`flow-refused`, `:4097-4109`), but no
console view prints either, so "this box has refused 3 connections" is not a question the CLI can
be asked.

**The one field written for a short transfer cannot be set.** `rec.stalled`
(`engine/simulator.js:4379`) is read by nothing — `grep -rn stalled engine/ server/ web/ test/`
returns the writer and two plan files — and no suite asserts it. It is also unreachable: the guard
(`:4367-4381`) needs a segment dropped *after* its predecessor was acknowledged, but every segment
of one flow is built from one tuple and walks the same path inside one `openFlow()` call, so no ACL,
VLAN, route or STP decision can drop the third segment and pass the first.

**The docs already say most of this.** `docs/SIMULATION.md:584` (no retransmission timer),
`:585` (API-only), `:588` (*"There are real timers. None."*), `:598` (*"no drops-by-reason beyond
the event log"*).

## What is missing or weak, ranked

1. **No surface a user has can start a conversation.** The flow engine — the largest recent
   addition to the model — is reachable only by `curl`. Everything below is downstream of this.
2. **The published table has no reader.** The server ships `state.flows`; the app draws events
   instead, so "what is open right now" has no answer, and `stalled`/`bytesDelivered` never reach a
   screen.
3. **A connection is invisible on the console**, and the code claims otherwise in a comment that
   names a command no dispatcher has.
4. **A refusal is a timeline line and nothing else.** The record is deleted, the counter is
   invisible to the console, and the reason string dies with the event buffer.
5. **`rec.stalled` is dead code**, so any view that printed it would print a field no run can set.

## Ordered steps

| # | step | size | closes |
|---|---|---|---|
| 1 | Research capture: the vendor's `show tcp brief` columns and state spellings, what `show tcp` adds per connection, the empty-table answer, and whether a NAT-translated row shows the inside or the outside address. One `research/show-tcp-brief.md`, sources only. | S | — |
| 2 | `show tcp brief` on the console: one row per record from `flow.listFlows(this.sim.flowState)` whose `srcDevice` or `dstDevice` is this box, `Local Address  Foreign Address  (state)` with the state word from step 1 mapped **once** in `engine/flow.js`, the empty case in the vendor's words, `SHOW_VIEW_WORDS` (`engine/cli.js:203`) entry plus the `help` index and a `docs/CLI.md` row. The docs must state where a flow comes from, because until step 4 a console-only lab shows an empty table. | S | 3 |
| 3 | The panel: a Flows table in `web/app.js` reading the `state.flows` already on the wire, columns from step 1, `summary` as the label, total/bytes-delivered as its own column, and a Close button wired to the existing `DELETE /flows/:id`. No new endpoint; counters come from `GET /flows` (`server/index.js:1293`). | M | 2 |
| 4 | Open one from the interface: a conversation form beside the ping form (`web/app.js:2489-2502`) — proto, port, bytes — posting to `POST /flows`, and saying in the panel that this is not an IOS command. **needs Jay's approval** (new surface, and the console deliberately has no such verb). | M | 1 |
| 5 | A refusal leaves a line: the last refusal per device (code, reason, destination, port) kept where a view reads it, printed as a footer under the table and in the panel, sourced from the `flow-refused` event the engine already emits (`engine/simulator.js:4097`). Never as a flow record — #1427's sweep must not see it. | S | 4 |
| 6 | Bookkeeping: `docs/SIMULATION.md:584-586` and `:598` gain the view and lose "beyond the event log"; `docs/CLI.md` exec table; the `show flows` claim at `server/index.js:414` corrected; and `rec.stalled` (`engine/simulator.js:4379`) deleted with one sentence saying mid-flow loss cannot happen in this model. | S | 5 |

## Risks

- **A view that is always empty.** Steps 2 and 3 land before anything can open a flow from the app,
  so every lab a reader builds shows nothing and the feature reads as broken. Step 2's receipt must
  quote the API-opened flow, and its docs must name `POST /flows`.
- **Two renderers of one sentence.** The console row and the panel row are the same fact; build it
  once in `engine/flow.js` and print it twice, the way `Device.macRows()` serves `show mac
  address-table` and `state.runtime` (#1327). Two formats would drift the moment one gains a column.
- **State spellings.** Engine states are `syn-sent`; the vendor's cells are `SYN_SENT`. A mapping in
  each surface is the #1293 drift class — one map, pinned by a test that both surfaces print the
  same word for every state in `STATE`.
- **A refusal history is not a flow.** Keeping it must not resurrect #1427 (a stale `established`
  row for a board with no cables). It is a separate per-device list, cleared by `Simulator.reset()`
  and never returned by `listFlows()`.
- **`stalled` must be deleted, not printed.** A panel that renders `rec.stalled` would promise a
  diagnosis (`segment 2, 1500 of 4000 bytes`) for a condition the data path cannot produce.

## Test strategy

New `test/flow-console-view.test.js`, built like `test/flow.test.js`: a flow opened over the engine
appears on **both** endpoints' consoles with the same summary, a third device answers with the
empty case, `DELETE /flows/:id` removes the row, the state word matches the vendor spelling for
`ESTABLISHED` and for a `syn-sent` record built directly, and a refused open leaves the footer.
`test/ui-render.test.js` (the stub-DOM harness that loads the real `web/app.js`) gains one
assertion: a serialized state carrying one flow renders one row. Regression set:
`test/docs-show-commands.test.js` (it types every `show` form `docs/CLI.md` names — the new row
must parse), `test/help-completeness.test.js` (both directions of the `show` index),
`test/console-over-http.test.js` (it opens a flow over HTTP and pins the counters),
`test/api-errors.test.js`, `test/flow.test.js`, then `npm test`.

## Issues this would close

None. #2336 (a stale `cli.js` line in a doc), #2337 (a Netgear PoE row), #2338 (Ubiquiti bridge
banks) are device/doc fixes with PRs open; #130 and #803 are device requests. This plan makes an
existing engine surface visible rather than adding a protocol.

## Deliberately left out

Retransmission and RTO — the reason a dropped segment is not retried — because `docs/SIMULATION.md:588`
says this model has no timers at all, and the instant a flow is asked at belongs to
`docs/plans/flow-determinism.md`. Congestion window, SACK, `TIME_WAIT`, path-MTU black holes
(`docs/plans/mtu-and-fragmentation.md` step 4 owns the flow half of that). HTTP request content,
TLS, SSH banners. A `telnet`/`ssh` console client, which is a line-oriented session inside a
session and needs its own plan. `show tcp`'s per-connection detail beyond the columns step 1
measures, and `POST /flows` argument validation, already pinned by `test/api-errors.test.js`.
