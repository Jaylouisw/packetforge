# Plan: a board you delete is back at the next boot, and a board that will not parse can never be deleted

Status: forward plan, no code. Measured on `5da9cc49`, 2026-11-20, by running the real server against a
scratch `PF_DATA` (`test/server-persistence.test.js:20-34` does the same). Closes **no** open issue: the
queue is two device requests (#803, #130) and neither is about the HTTP surface. Scope:
`server/index.js` (`loadSavedTopologies()`, the `topologies` branch of `handleApi()`), one new suite,
`web/app.js` only for the last step, and `docs/ARCHITECTURE.md` section "Boards". No engine change.

## What exists today

A board is a JSON file plus a live `Topology` in a `Map`. `saveTopologyNow()` (`server/index.js:147`)
writes `{format, version, id, savedAt, topology}` through a temp file and a rename, `broadcast()`
(`:618`) calls it on every mutation, and `loadSavedTopologies()` (`:200`) re-reads `TOPO_DIR` at boot.
That half is thorough: issue #24 (a restart threw the board away), #1315 (one file for two boards) and
#1520 (a stamp nothing read) are all closed by it.

The other half is missing. There is no `unlink` or `rmSync` anywhere in `server/` — grep returns zero
hits — and the only destructive route is four lines:

```
$ curl -X POST -d '{"id":"lab-keep"}' /api/topologies   -> 201, topologies/lab-keep.json exists
$ curl -X DELETE /api/topologies/lab-keep               -> {"ok":true}
$ curl /api/topologies                                  -> {"ids":["default"]}
$ ls topologies/                                        -> lab-keep.json      <- still there
   ... restart ...                                      -> {"ids":["default","lab-keep"]}
```

* **`DELETE` deletes the map entry and nothing else.** `server/index.js:844` is
  `topologies.delete(topoId)`; the file survives and `loadSavedTopologies()` (`:200-224`) brings the
  board back on the next boot. Measured above.
* **`DELETE` says yes to a board that never existed.** `DELETE /api/topologies/never-existed` -> 200
  `{"ok":true}`, because `topo` (`:835`) is never consulted before the delete.
* **A file that will not parse is unreachable and undeletable.** Writing `{"hello":"world"}` into
  `topologies/broken.json` and booting gives `could not load broken.json: no devices and no links: not
  a topology document - left alone` (`:214`), the board is absent from `GET /api/topologies`, and
  `DELETE /api/topologies/broken` answers 200 while the file stays. The only recovery is `rm` in the
  data directory. Leaving it alone is deliberate and right (`:199`); leaving it *invisible* is not.
* **The list is names only.** `:807` returns `{ids: [...]}`. `savedAt` is written at `:158` and read
  nowhere in the repository (grep: one hit, the write), so nothing can say how old a board is, how
  big, or whether it is still on disk.
* **`POST` on an occupied name answers 201.** `:812-830` returns `201 {id, state}` whether it created
  the board or silently opened someone else's; measured against the existing `default`.
* **Deleting a board tells no one.** `broadcast()` (`:618`) is what persists *and* what every other
  tab draws from, and the `DELETE` branch does not call it, so a second browser keeps painting a board
  that no longer exists. `sessions` (`:87`) is also left holding `topoId:devId` keys for the dead id.
* **Nothing tests any of this.** No suite issues `DELETE /api/topologies/:id` (`test/persistence.test.js`
  deletes a *device*; `:226-231` and `test/server-persistence.test.js:149` both assert a bad *file* is kept),
  so the resurrection is not a regression anyone can watch fail.
* **The UI addresses one board by a constant.** `web/app.js:4` is `const TOPO = 'default'` and the
  client never calls `GET /api/topologies`, so the multi-board API is unreachable by a person: there is
  no open, no new and no delete in the app, only Import (`:2962`) and a destructive Reset (`:2994`).

## What is missing or weak, ranked

1. **A delete that does not delete** — the data outlives the API's answer, so the answer is false.
2. **An unreadable board has no way out** — invisible in the list, immune to `DELETE`, log-only.
3. **The list cannot describe a board** — no size, age, or unreadable bucket, so a UI cannot be built.
4. **`DELETE` and `POST` do not distinguish success from no-op** — 200 and 201 for nothing done.
5. **No board surface in the UI** — the API is multi-board; the product is single-board by constant.

## Ordered steps

| # | step | size | closes |
|---|---|---|---|
| 1 | `DELETE /api/topologies/:id` unlinks `topologyFile(id)` (`:139`) after the map delete, ignoring `ENOENT`, and clears the board's `sessions` keys. Refuse `default` with `409 E_BOARD_IS_DEFAULT` while `web/app.js:4` still addresses it by name, and say so in the body. | S | 1 |
| 2 | `DELETE` answers `404` when the id is neither loaded nor a file in `TOPO_DIR`, so `never-existed` stops reporting success. Same branch, one lookup through `fs.existsSync(topologyFile(id))`. | S | 4 |
| 3 | `loadSavedTopologies()` (`:200`) keeps refusing to *adopt* an unreadable file but records it: a module-level `unreadable` map of `{file, problem}` from the `:214` catch. `GET /api/topologies` gains `unreadable: [{file, problem}]`, and `DELETE` on one of those names unlinks the file — an explicit act by the operator, never automatic. | S | 2 |
| 4 | The list describes: keep `ids`, add `boards: [{id, devices, links, bytes, savedAt}]`, `savedAt` from the envelope this server wrote (`:158`) or the file's mtime for older ones. One `fs.statSync` per board, and the array is read once per request. | S | 3 |
| 5 | `POST /api/topologies` answers `409 E_BOARD_EXISTS` with the existing `id` instead of `201`, so a client can tell "created" from "adopted". Keep the 201 body identical for a real create. | S | 4 |
| 6 | Call `broadcast(topoId)` on delete as a `{type: 'topology-gone', topologyId}` frame rather than re-sending a state for a board that is gone, and have `web/app.js` clear the canvas on it. Without this, step 1 makes two tabs disagree about whether the lab still exists. | S/M | 1 |
| 7 | **needs Jay's approval** — a board surface in the UI: `TOPO` (`web/app.js:4`) becomes a mutable selection, the topbar lists `boards` from step 4, and New / Open / Delete exist. New product surface, and the delete button is the destructive one, so the wording is a decision. | M | 5 |

## Risks

* **Unlink is the one irreversible act in the server.** `saveTopologyNow()` is called from
  `broadcast()`; a request already in flight for a deleted id would `ensureTopology()` a fresh empty
  board and save *it* under the old name. Step 1 must delete the map entry and the file together, and
  step 6 is what stops a client from driving further writes at a dead id.
* **`default` is load-bearing.** `ensureTopology('default')` runs at boot (`:252-254`) and the UI hard-codes
  it; deleting it leaves a UI that 404s on every call. That is why step 1 refuses it rather than
  recreating it — a recreate-on-read is the "empty board silently adopted" failure of #1315 in a new
  costume.
* **Unreadable files are the operator's work** (`:199`). Step 3 must surface and never sweep: a
  migration that deletes what this build cannot parse would destroy exactly the file a later build was
  going to read.
* **`statSync` per board on every list.** Boards are few and small, but do it once per request, not per
  row of a table in a render loop.

## Test strategy

New `test/board-delete.test.js`, modelled on `test/server-persistence.test.js` (spawn on a scratch
`PF_DATA`, kill, restart): create -> delete -> `GET` no longer lists it -> restart -> still not listed
and the file is gone; `DELETE` twice -> second is 404; `DELETE default` -> 409 and the file survives;
a planted `{"hello":"world"}.json` -> appears under `unreadable`, `DELETE` removes it, and a restart
with it untouched still logs "left alone". Then `npm test` and `node scripts/smoke-http.js`.

## Issues this would close

None open. It closes the class behind #24, #1315 and #1465 without reopening any of them, and it is the
precondition for any "your labs" page.

## Deliberately left out

Board **rename** and **duplicate** (new API surface, and `PATCH` on a board has no caller to justify it
yet), the fixed export filename at `web/app.js:2957` (`packetforge-topology.json` for every board —
cosmetic, and the exported document already carries `format`/`version`/`seq`), document-version
migration (`DOC_VERSION` is still 1 and `engine/topology.js:69` refuses newer files with a sentence
that names both versions — a migration path is a separate decision), and the `fullState()`-twice cost
per mutation, which is a performance seam that needs a measurement before a plan.
