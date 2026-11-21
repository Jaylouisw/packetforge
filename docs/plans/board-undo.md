# Plan: a delete is one keystroke and nothing takes it back

Status: forward plan, no code. Measured on `b40915a1`, 2026-11-21. Closes **no** open issue — the queue
holds one device request (#130) and this is not one. Scope: one new `web/history.js`, `web/app.js` (the
`api()` funnel, the keyboard handler, the socket handler), `web/index.html` (a script tag and two
buttons), one new suite, one short section in `docs/ARCHITECTURE.md`. No engine change, no workflow
change, and **no `server/index.js` change**: the door this plan needs already exists.

The surface is not new. `docs/ROADMAP.md:35` lists *"Multi-select, copy/paste, alignment snapping,
undo/redo"* as unbuilt; this plan takes the undo/redo quarter of that row and leaves the rest alone.

## What exists today

**Every edit is a one-way request.** `api()` (`web/app.js:318`) is the single funnel for the UI's calls,
and the board is mutated through it at twenty-odd sites: add device (`:964`), add cable (`:1078`,
`:1453`), move a device (`:1179`), enable/disable a port and set its role (`:1816`, `:1833`), `ip`
(`:1932`), cable length (`:2440`), console commands (`:2478`, `:1842`), import (`:2977`), blank board
(`:3001`), reset (`:3010`). Each returns the whole board and the caller adopts it (`topo = r.state ||
topo`). `setLinkState` (`:2869`) is the one mutation that bypasses `api()` with its own `fetch()`.

**Nothing remembers the board it replaced.** `grep -n "history" web/*.js` matches two lines about a `localStorage`
preference (`:890`, `:908`) and nothing else; the one `undo` in `web/` is a comment at
`:689` about three controls. There is no stack, no snapshot, no inverse operation.

**Deletion is a keystroke with no question and no recovery.** Backspace/Delete is bound at
`web/app.js:3030` and calls `deleteDevice` (`:2924`) or `deleteLink` (`:2939`), which go straight to
`DELETE`. `deleteDevice` takes the device's cables with it. The only `confirm()` in the UI is the
blank-board button (`:2999`), so a hand-typed configuration — set one command at a time through the
console — dies on a stray keypress with nothing to bring it back.

**The replacement mechanism is already on the server.** `POST /api/topologies/:id/load`
(`server/index.js:1403-1422`) validates the stamp and shape (`documentShapeProblem()`, `:361`), replaces
the live board (`:1416`), drops that board's console sessions (`:1417`), broadcasts
(`broadcast()`, `:618-624`), and answers with the full state (`:1422`). The client's own `topo` object
*is* a valid document: `fullState()` (`:377`) starts from `topo.serialize()`
(`engine/topology.js:770-807`), which carries `format`/`version`/`seq`/`devices`/`links`/`layout`, the
conversations and the DHCP leases — the same shape the import path already posts back (`:2977`).

**A second tab cannot be told from the first.** The socket frame (`server/index.js:624`) is
`{type, topologyId, state}`, and the client adopts every one of them (`web/app.js:3144-3156`). Nothing
carries an origin or a client id, so a client cannot distinguish its own echo from another tab's edit.

## What is missing or weak, ranked

1. **No undo of a destructive edit** (`docs/ROADMAP.md:35`). A device delete is unrecoverable in the UI, and the
   keystroke that causes it is the one people press to go back.
2. **No recovery from a wrong layout save.** A dropped box is saved at once (`:1179`); undoing it means
   dragging it back by eye, which is a different position, not the old one.
3. **No redo**, so an undo that turns out to be wrong has no forward path either.
4. **Foreign-change blindness** (below, step 5). Whole-document restore is only safe if the client knows
   whether the board moved underneath it; today it cannot.
5. **`/load` does not restore ARP or MAC tables** — those are runtime (`fullState()`, `:384-405`), not
   `serialize()`. An undo of a configuration edit therefore re-reads cold on the simulate tab. Acceptable,
   but it has to be said in the toast or in the docs, not discovered.

## Ordered steps

| # | step | size | where |
|---|---|---|---|
| 1 | **`web/history.js`: a pure ring of documents.** `createHistory({limit: 50})` with `record(doc, {label, key, at})`, `undo(current)`, `redo(current)`, `clear()`, `canUndo()`, `canRedo()`. Copies on the way in and out (JSON round-trip; no dependency), drops the oldest entry at `limit`, clears the redo stack on a new record, and coalesces two entries with the same `key` inside 600 ms so one drag is one step. No DOM, no `api()`, exposed as `window.PFHistory`. `index.html` loads it beside `canvas.js`, before `app.js`. | S | new file, `web/index.html:136` |
| 2 | **Record at the one funnel.** In `api()` (`:318`), for every `method !== 'GET'`, record the *pre-call* `topo` with a label from the path (`devices`, `links`, `layout`, `config`, `interfaces`, `load`, `reset`) and a coalescing key. A `restoring` flag keeps step 3's own `/load` out of the stack. `setLinkState` (`:2869`) is left out on purpose — see below. | M | `web/app.js:318` |
| 3 | **Undo and redo restore through `/load`.** `undo()` posts the popped document to `POST /topologies/:id/load`, adopts `r.state`, keeps the replaced document as the redo entry, re-selects the device if it still exists, and toasts `Undid: deleted device d3`. What is posted is the document half of the snapshot — the keys `serialize()` wrote — not the `runtime`, `verdicts` or `stp` rows `fullState()` adds for display. A refusal (`E_BAD_DOCUMENT`) puts the entry back and reports, so a failed undo is not a lost one. | M | `web/app.js` beside `syncTopology()`, `:3092` |
| 4 | **Bind it.** `Ctrl/Cmd+Z` → undo, `Ctrl/Cmd+Shift+Z` and `Ctrl+Y` → redo, added to the handler that already owns `Delete`/`Backspace` and already ignores `INPUT`/`TEXTAREA` (`:3030-3048`). Two small buttons beside zoom (`index.html:80-82`) carrying `disabled` when the stack is empty, with `title` naming the step they would reverse. | S | `web/app.js:3030`, `web/index.html:80` |
| 5 | **Clear the stack when the board moves underneath.** In the socket handler (`:3144`), if the incoming document is not the one this client last adopted, `clear()` the history and say so once in the status bar (`History cleared — another tab changed the board`). Local edits still record normally afterwards. | S | `web/app.js:3144` |
| 6 | **Say it exists.** A short "Undo" subsection under `## The UI` in `docs/ARCHITECTURE.md` (after `:1704`): what an entry is (a whole document), what it does not restore (ARP/MAC tables, console sessions), and that it is per-tab and memory-only. | S | `docs/ARCHITECTURE.md:1704` |

Total: **M**. Steps 1 and 4 land independently; 2 and 3 are one PR because recording without restoring
is dead code, and step 5 rides with 3 only if it is not already reviewable alone.

## Risks

* **Whole-document restore is a clobber.** Two tabs, one undo, and the second tab's edit is gone. Step 5
  narrows the window instead of closing it; the honest fix is an origin tag on the socket frame, which
  changes `server/index.js` and is left out of this plan.
* **Console sessions end on every undo** (`server/index.js:1417`). That is correct for a replaced board,
  and it will read as a surprise on the console tab; step 6 says so.
* **Coalescing is a judgement call.** A 600 ms window makes a drag one step and two deliberate clicks
  two; too generous a window swallows a second edit, too mean a window makes a drag three undos.
* **Memory.** Fifty documents of a large lab is a few hundred kB; `limit` is the dial and the test asserts
  the cap, not a byte budget.
* **Step 2 trusts the funnel.** A future endpoint added with a raw `fetch()` would not record. The static
  guard below makes that omission fail a test rather than go unnoticed.

## Test strategy

* New `test/board-history.test.js`, in two halves, following `test/ui-action-failures.test.js`: the module
  in a bare `vm` context (cap, ordering, coalescing by key and by time, redo cleared by a record, copies
  not aliased), and the real `web/app.js` in the stub-DOM harness that file already builds (`:132-187`), driving a
  `keydown` `Ctrl+Z` and asserting one `POST .../load` carrying the *previous* device list, one canvas
  redraw, and a stack that is empty afterwards.
* One static sweep in the same file: every `api('POST'|'PATCH'|'DELETE'` call site and every raw
  `fetch('/api/` in `web/*.js` is either inside `api()` or named in a small allow-list with a reason
  (`setLinkState`), so a new endpoint cannot slip past the funnel silently.
* A second-tab case with two stub contexts sharing one server stub: tab A deletes, tab B's stack is empty
  and its status line says why.
* `node test/ui-dom-contract.test.js` stays green and is the guard for step 4's new buttons: it fails when
  `app.js` queries a selector `index.html` does not declare (`:49-55`), which is the exact failure mode of
  a toolbar button that exists only in the code.
* `npm test` (452 suites by `scripts/run-tests.js --list`); `smoke` unchanged, since no server route is touched.

## Deliberately left out

* **Multi-select, copy/paste and alignment snapping** — the other three quarters of `ROADMAP.md:35`,
  each its own plan and each larger than this one.
* **Server-side history** (an undo endpoint): it would make undo survive a reload and work across tabs,
  but it is a new API surface, it belongs in `server/index.js`, and it is not needed to stop a keystroke
  from being final. **needs Jay's approval** if anyone wants it.
* **Undo of `setLinkState`** (`:2869`): link up/down re-bases convergence at a wall-clock instant
  (`atMs`), so "undo" would be a different convergence, not the previous one. The `no shutdown` form in
  the console already expresses the intent.
* **Undo of console commands** — `docs/plans/undo-granularity.md` owns the `no` forms, and the document
  snapshot here already covers the board-level effect.
* **Persisting the stack** across reloads (`localStorage`), and any collaborative merge/CRDT behaviour.

## Issues this would close

None. The queue is one device request (#130). It advances `docs/ROADMAP.md:35` without ticking the box,
because three of that row's four items are still absent.
