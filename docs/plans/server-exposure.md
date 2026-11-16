# Plan: the default posture is 0.0.0.0, a star, and no Origin check

Status: forward plan, no code. Answers #1527, which is the stated precondition for storing any real
device credential. Touches `server/index.js`, `server/ws.js`, `web/app.js`, `Dockerfile`, `test/`,
`SECURITY.md`, `ARCHITECTURE.md`, `README.md`. The bearer-token half of #1527 is deliberately not
here (see "Deliberately left out"): it needs a credential surface to protect, and that surface does
not exist yet.

## What exists today

* **The bind is every interface.** `server/index.js:26` reads `PORT` from the environment;
  `:1489` calls `server.listen(PORT, function () {...})` with no host argument, so Node listens on
  `::`/`0.0.0.0`. Nothing prints which address was taken - `server.address()` is never read - so a
  laptop on a cafe network and a container behind a proxy look identical in the log.
* **CORS is a wildcard on every JSON answer.** The header is set in `sendJSON` (`:467`), in
  `sendImmutableJSON` (`:523`), and on the preflight (`:1408-1412`, which answers `204` with
  `Access-Control-Allow-Methods: GET,POST,DELETE,OPTIONS`). Any page Jay visits can therefore
  `fetch('http://127.0.0.1:8000/api/topologies/default')` and read the whole board without a
  WebSocket at all. #1527 names only the WebSocket; the REST door is wider and easier to use.
* **The WebSocket upgrade checks exactly one header.** `server/index.js:1418` hands the request
  straight to `wss.handleUpgrade(req, socket)`; `server/ws.js:21` reads `sec-websocket-key` and
  nothing else - no `Origin`, no `Host`, no token. On success `server/index.js:1450` immediately
  pushes the `default` board's full state, before the client has sent anything.
* **The client does not subscribe.** `web/app.js:3058` opens the socket and `:3067` calls
  `syncTopology()` (a `GET /topologies/<id>`), so the unsolicited push at `:1450` is redundant for
  the UI and exists only for other clients.
* **No test asks where the server bound.** `scripts/smoke-http.js:84` and
  `test/server-persistence.test.js:63` spawn the real server with `PORT` and `PF_DATA` and then poll
  `127.0.0.1`; a default of `0.0.0.0` passes both. `test/ws-reconnect.test.js` stubs the socket
  entirely, so no test exercises the upgrade path.
* **The documentation states the posture as the operator's problem.** `SECURITY.md:40-43` says the
  server "binds to `0.0.0.0` by default - bind it to a trusted network or localhost if you expose it"
  and that topologies "are not authenticated". That is honest today and must be rewritten by the same
  PR that changes the behaviour, not after it.

## What is missing or weak, ranked

1. **Listening on every interface by default** (`:1489`). The common case is one person on one
   machine; the safe default is loopback, and exposure should be something you ask for.
2. **A wildcard `Access-Control-Allow-Origin` on topology data** (`:467`, `:523`). This is the
   cheapest read path for a hostile page, and #1527 does not mention it. It can be narrowed without
   touching the public, immutable endpoints.
3. **An upgrade with no `Origin` check** (`:1418` + `ws.js:21`), followed by an unsolicited dump of
   the default board (`:1450`).
4. **No regression net.** Nothing in `test/` would notice if any of the above came back.
5. **The credential surface itself** - out of scope here; it needs a design decision from Jay.

## Ordered steps

| # | step | size | closes |
|---|---|---|---|
| 1 | `PF_HOST` in `server/index.js`, default `127.0.0.1`, validated through the same startup-error path as `PORT` (`formatStartupError`); listen on it and log `server.address().address` instead of the hard-coded `Local:` line at `:1493`. `Dockerfile` gains `PF_HOST=0.0.0.0` next to `PORT=8000`, so the published image keeps working. New `test/server-bind.test.js` (below). | S | #1527 (bind) |
| 2 | An `allowOrigin(req)` helper in `server/ws.js`, injected into `handleUpgrade` as an option the way `onMessage` is already assigned from `index.js`, wired at `server/index.js:1418`: an absent `Origin` is allowed (curl and the tests send none), a same-origin `Origin` (scheme+host+port equal to `Host`) is allowed, `PF_ALLOWED_ORIGINS` (comma list) is allowed, anything else is refused with `403` **before** the `101` and the socket destroyed. New `test/ws-origin.test.js`. | S/M | #1527 (WS) |
| 3 | Narrow CORS: keep the wildcard for the two immutable, public endpoints (`/api/catalog`, `/api/media`), which `sendImmutableJSON` serves and which carry no board; for every other `/api/` path echo the caller's `Origin` only when `allowOrigin()` says yes, and send no ACAO header otherwise. Preflight at `:1408` follows the same rule. Test the three cases against a real server: allowed origin gets the echo, foreign origin gets no header, no `Origin` is unaffected. | M | #1527 (HTTP half) |
| 4 | Delete the unsolicited push at `:1450`; the `onopen` handler at `web/app.js:3063` gains `{"type":"subscribe","topologyId":TOPO}`, which the server already answers at `:1435`. Drop the "a new connection" row from the message table at `ARCHITECTURE.md:344-357`. | S | - |
| 5 | Docs in the same series: `SECURITY.md:35-43` rewritten to the new default plus the two knobs; `ARCHITECTURE.md` "The server" gains one paragraph on bind, Origin and CORS; `README.md:44` and `:49` say what the container sets and what a bare `npm start` exposes. | S | #1527 (docs) |

Each row is one PR. Steps 1 and 5 can land together; 2 and 3 must not, because a broken Origin rule
and a broken CORS rule would be indistinguishable in one bisect.

## Risks

* **The demo is deployed from outside this repo.** `deploy.sh` on the host clones `main` and recreates
  the container; if the image does not set `PF_HOST`, or a host-side `docker run` pins `-p 8000:8000`
  without it, the public demo goes dark on the merge. Step 1 must ship the Dockerfile change in the
  same commit, and the demo needs a post-merge check by whoever owns that host - not this stream.
* **Reverse proxies.** Behind cloudflared or nginx the `Host` header is the public name, so
  same-origin derivation is right. Do **not** start trusting `X-Forwarded-Host` in this plan: that is
  a new hole bought for a convenience `PF_ALLOWED_ORIGINS` already provides.
* **Third-party consumers of the API.** Anyone reading `/api/topologies/*` from another origin loses
  that path in step 3. That is the point, but it belongs in the PR body rather than in a bisect.
* **A bad bind must name the address.** `EADDRNOTAVAIL` on a mistyped `PF_HOST` has to print the value
  tried, the way the `EADDRINUSE` message already prints the port.

## Test strategy

`test/server-bind.test.js`: spawn `server/index.js` with `PF_HOST` unset, poll `127.0.0.1:<free port>`
until it answers `/api/version`, then assert a connection to the host's first non-loopback IPv4
(`os.networkInterfaces()`) is refused; repeat with `PF_HOST=0.0.0.0` and assert it is accepted. Skip
the second half when the machine has no non-loopback address (CI containers often do not), and always
reap the child in a `finally`.

`test/ws-origin.test.js`: drive a raw `net` socket through the handshake, asserting `101` for absent
and same-origin, `403` for `http://evil.example`, and that no board frame arrives before `subscribe`.
Then `npm test`, and `node scripts/check-doc-citations.js` after step 5, because `ARCHITECTURE.md` is
cited by line from other pages.

## Deliberately left out

* **A bearer token on the credential surface** (#1527 item 3). There is no credential store to guard
  (`grep -ri credential engine/ server/` finds nothing), so a token today would protect nothing and
  would have to be redone once the store exists. When it lands it needs its own plan, and it needs
  Jay's approval because it changes how the UI authenticates.
* **TLS, user accounts, per-board access control, rate limiting.** A loopback default plus an Origin
  check is the proportionate answer for a single-user simulator; anything more is product surface.
* **#1507 and #1508** (disk pressure, the auto-rebase stand-down) - infrastructure, not this subject.

## Open issues this would close

#1527 - items 1 and 2, plus the documentation it asks for. The token item stays open on purpose, and
the plan says so in a sentence a reader can quote.
