# Plan: a wrong method is answered `404 unknown endpoint`, and the preflight lists one the API refuses

Status: forward plan, no code. Measured on `fcf929dd`, 2026-11-18, by spawning the real server
(`PORT`/`PF_DATA` set, as `test/server-cors.test.js:66-71` does) and issuing nine requests. Closes
**no** open issue - the queue is six device requests (#130, #742, #803, #807, #808, #810) and none of
them is about the HTTP surface. Scope: `server/index.js` (`handleApi()`, the `OPTIONS` branch of
`createServer()`), one new table module, one new suite, `docs/ARCHITECTURE.md` section "What a wrong
request gets". No engine, no test-helper and no workflow change.

## What exists today

**The route inventory is 21 conjunctions, and it is the only statement of itself.** `handleApi()`
(`server/index.js:749-1449`) is an if-chain where a route is `parts[n] === 'x' && method === 'y'`:

```
GET        /api/catalog  /api/version  /api/requests  /api/media
GET,POST   /api/topologies             GET,DELETE /api/topologies/:id
POST       .../devices                 DELETE     .../devices/:dev
POST       .../links  .../validate-link  .../link-options
DELETE,PATCH,POST .../links/:link      POST,PATCH .../links/:link/state
POST       .../config/:dev  .../interfaces/:dev/:port  .../ping
GET,POST   .../flows                   GET,DELETE .../flows/:id
POST       .../layout  .../load  .../reset
```

**A right path with a wrong method falls off the end of that chain.** Measured:

| request | today | should be |
|---|---|---|
| `PUT /api/catalog` | `404 {"error":"unknown endpoint"}` | `405`, `Allow: GET, HEAD` |
| `DELETE /api/version` | `404 {"error":"unknown endpoint"}` | `405`, `Allow: GET, HEAD` |
| `PATCH /api/catalog` | `404 {"error":"unknown endpoint"}` | `405`, `Allow: GET, HEAD` |
| `POST /api/topologies/default` | `404 {"error":"unknown endpoint: /api/topologies/default"}` | `405`, `Allow: GET, DELETE, HEAD` |
| `HEAD /api/catalog` | `404`, empty body | `200`, no body |
| `GET /api/nonsense` | `404 {"error":"unknown endpoint"}` | unchanged |

The same mistake gets two different bodies, because there are two fall-offs: `:832` (anything outside
`/api/topologies/...`) says `unknown endpoint` with no path, `:1445` says `unknown endpoint: <path>`.
And a wrong method is indistinguishable from a path typo - `GET /api/nonsense` and `PUT /api/catalog`
are the same status and the same shape - so a client cannot tell "you spelled it wrong" from "you may
not do that here".

**One route already knows about 405, and omits the header.** `:979-982`, `/links/:id/state`, answers
`405 {"error":"use POST"}` with no `Allow`. RFC 9110 section 15.5.6 makes `Allow` mandatory on a 405,
so the verb exists in the code once, in prose, without the machine-readable half.

**The static layer one screen away does it correctly,** and the docs say so: `serveStatic()`
(`:711-716`) answers `405` with `Allow: GET, HEAD` for four write methods, and
`docs/ARCHITECTURE.md:409` documents that row. `handleApi()` accepts `HEAD` nowhere, so
`HEAD /api/catalog` is a 404 while `HEAD /index.html` is a 200 - two answers to one question in one
server. `test/static-surface.test.js:168-175` asserts the static half; nothing asserts the API half.

**The preflight names a method the API implements and then refuses.** `createServer()` answers every
`OPTIONS` before it looks at the path (`:1457-1467`), from one constant:
`'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS'` (`:1459`). `PATCH` is absent, and two
routes accept it (`:1023`, `:1024`) - `web/app.js:2395` sends `PATCH .../links/:id` when a cable's
length is edited, through `api()` (`:318`), which always sets `Content-Type: application/json`, so the
call preflights. `PF_ALLOWED_ORIGINS` (`:44`, documented `docs/ARCHITECTURE.md:383`) admits a page on
another origin on purpose, and that page's cable-length edit is refused by the browser before it
leaves. Same-origin is unaffected, which is why nothing has reported it. `OPTIONS /api/nonsense` also
answers `204` with that method list, for a resource that does not exist (measured).
`test/server-cors.test.js:158-169` asserts the preflight's origin rules and never its method list.

**The docs have a table for a wrong request with no row for a wrong method.**
`docs/ARCHITECTURE.md:421-433` lists `400` (bad body), `400 E_BAD_REQUEST` (missing field), `404` (bad
id) and `409/422` (engine refusal) - four rows, none of them a method or an unknown path.

## What is missing, ranked

1. **One statement of which methods each path accepts.** There is none; the truth is 21 branches. Every
   fix below derives from it, and so does any future route.
2. **`405` + `Allow` for a known path, wrong method.** Above the other two because it is what a person
   types: `curl -X POST ...` is a normal mistake, and `404 unknown endpoint` sends them to look for a
   typo that is not there.
3. **A per-path preflight.** One constant cannot be right for 21 paths; today it is wrong for two
   routes and vacuous for every path that does not exist.
4. **`HEAD` wherever `GET` works.** Correctness, low stakes: no client of this app sends it, but the
   answer is a lie and the static layer already proves the intended one.
5. **Discovery.** `GET /api` naming the table. New public surface - **needs Jay's approval**, and the
   plan is complete without it.

## Ordered steps

1. **`server/routes.js`: the 21 rows as data - `{ pattern, methods }`, no handlers.** `handleApi()`
   keeps its if-chain; the table is consulted only for "does this path exist, and with which methods".
   Additive: one new file plus a six-line call, so it lands without touching a handler and without
   conflicting with the other streams. **M**
2. **`405` + `Allow` from the table.** A matched path with an undeclared method answers `405` with
   `Allow: <methods>, OPTIONS, HEAD` and a body naming that path's methods; a path no row matches keeps
   `404 unknown endpoint: <path>`. Put `Allow` on the existing `:981` too. Separate PR from step 1, so
   the table's own introduction is provably behaviour-free. **S**
3. **Preflight from the table.** `Access-Control-Allow-Methods` becomes the matched row's methods plus
   `OPTIONS`; a path no row matches keeps `204` and the `Origin` rule but claims no methods. This is
   where `PATCH` is fixed. **S**
4. **`HEAD` = `GET` in `handleApi()`.** Dispatch as `GET`, suppress the body. `sendJSON` already owns
   the revalidation and gzip paths; `serveStatic()` shows the shape to copy. **S**
5. **Docs.** Add the method row to `docs/ARCHITECTURE.md:421` (a method the path does not accept:
   `405` with `Allow`; an unknown path: `404` naming it), and one line in `CONTRIBUTING.md`: a new
   endpoint adds a row, and the sweep suite tells you if you forgot. **S**
6. **`GET /api` - the table, described.** **needs Jay's approval.** **M**

## Risks

* **Drift.** The table duplicates the if-chain, and a duplicate is wrong eventually. The sweep below
  catches the dangerous direction - a row promising a method the handler does not implement, which is
  the `PATCH` failure in reverse - but it cannot see a method a handler accepts that no row declares.
  Say so in the module header rather than pretending the test is total.
* **`OPTIONS` runs before the `/api/` test** (`:1470`). Step 3 must keep the static preflight and the
  origin echo byte-identical for non-API paths; `test/server-cors.test.js` is the guard.
* **`server/index.js` is the most contested file in the repository.** Step 1 adds a file and calls into
  it; steps 2-4 are three small edits to distinct regions. Land 1 first, alone.
* **Status-change risk is nil for the UI**: `web/app.js` only ever sends the method its own route
  declares, so no client of this build can start receiving a `405` it did not get before.

## Test strategy

* New `test/api-methods.test.js`, spawning the real server exactly as `test/server-cors.test.js:66`
  does. For each of the 21 rows, against a real board, sweep `GET POST PUT PATCH DELETE HEAD OPTIONS`
  and assert two things: a declared method never comes back with a body that begins `unknown endpoint`
  (a `topology not found` or a `400` is the handler answering, which is the point), and an undeclared
  one answers `405` carrying an `Allow` that names the declared methods. Today it fails on every
  undeclared-method pair and on `HEAD` for the eight `GET` rows; after steps 2 and 4, only the
  handler's own answers are left.
* `test/server-cors.test.js` stays green through step 3, plus one assertion that the preflight for
  `/api/topologies/default/links/L1` names `PATCH`.
* `node scripts/smoke-http.js` unchanged and still green - it asserts specific success statuses on the
  legal path, which is what proves steps 2-3 did not disturb it.
* `npm test` (330 suites under `test/`); `static-surface`, `server-cors` and `server-bind` are the ones
  that bite.
* Rerun the nine-request matrix and paste it into each PR body - the before and after is the finding.

## Issues this would close

None. Every open issue is a device request (#130, #742, #803, #807, #808, #810); this plan repairs an
HTTP surface the repository already ships and already documents.

## Deliberately left out

* **Handlers into a router framework.** 700 lines and 64 `sendJSON` sites for no user-visible gain, and
  it conflicts with every other stream working in `server/index.js`. The table is the useful half.
* **Auth, tokens and the `Origin` posture.** `docs/plans/server-exposure.md` steps 4-5 own who may ask;
  this plan only changes what the API says when you ask wrongly.
* **Accepting `POST` as an alias for `PATCH`** so a client that cannot send `PATCH` still works - a
  compatibility decision, not a defect, and it would double every mutating row.
* **Query strings, pagination, and `409` versus `422` for engine refusals** - those rows are right;
  only the method axis is missing.
