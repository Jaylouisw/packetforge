# Architecture

PacketForge is deliberately split so that the **simulation engine**, the
**hardware catalog**, the **server**, and the **UI** are independent layers.

```
┌────────────────────────────┐
│  web/  (vanilla JS + SVG)  │   palette · canvas · inspector · console
└──────────────┬─────────────┘
               │ fetch + WebSocket (JSON)
┌──────────────▼─────────────┐
│  server/  (http + ws)      │   REST API, topology store, live sync
└──────────────┬─────────────┘
               │
┌──────────────▼─────────────┐
│  engine/  (pure JS)        │   Topology → Simulator → events
└──────────────┬─────────────┘
               │ reads
┌──────────────▼─────────────┐
│  devices/  (JSON only)     │   vendor/model/ports/capabilities
└────────────────────────────┘
```

## The engine

Everything is a **frame** (`{srcMac, dstMac, etherType, ip?, arp?, icmp?}`) that
moves between device **interfaces** across **links**. The simulator is an
event-driven work queue: each transmission is one "step", and every decision
emits an event so the UI can replay the packet path.

### Module map

Thirty-two files, one job each. Every one is pure except `optical.js`, which lazily reads part
numbers out of `catalogue/optics/` — and even `flow.js` and `nat.js` describe themselves as taking
caller-supplied logical ticks rather than `Date.now()`, so the same lab replays identically. That is
why the suites can drive these modules directly. The purpose in each row is the file's own header
line, so it can be checked against the source rather than trusted — with four honest exceptions, found
by comparing every row to `head -5 engine/<file>.js`: `convergence.js` opens its header at the 802.1D
defaults, `segment.js` at the broadcast-domain tagging rule, `scion.js` with the acronym before the
purpose on the next line, and `nat.js`, whose row lists the three translation flavours from the body of
its header (`static` / `dynamic` / `pat`, `nat.js:4-8`) instead of repeating its first line. Those four
rows paraphrase the header's intent; the other twenty-eight are the header line itself, sometimes with a
gloss after an em dash (`index.js` is the clearest: the header is `public engine API.` and the row adds
*re-exports the lot*).

| Module | Job |
|---|---|
| `index.js` | public engine API — re-exports the lot |
| `simulator.js` | event-driven packet simulation: the forwarding path and the event queue |
| `device.js` | Device + Interface model (vendor-agnostic), `routeTo()`, `CAPABILITIES`. Also hosts `addSvi()` / `hasSvi()` / `bridgedInterfaces()` (a switch's own address on a VLAN — a host function, never a bridge egress; `canTerminate` in the simulator gates termination), `betterRoute()` / `ADMIN_DISTANCE` — the one route-selection rule: longest prefix, then lower administrative distance, used by **both** the IPv4 (`routeTo`) and IPv6 (`route6To`) data paths and by both show tables. It exists because the IPv6 path had a second, hand-written copy that drifted twice — a connected loop with no comparison at all, and a static-versus-connected tie that went to the static route |
| `topology.js` | container of devices + links, with (de)serialisation |
| `link.js` | a physical link (cable / optic / DAC) between two interfaces |
| `media.js` | physical media, transceiver and port-hardware model |
| `optical.js` | optical distribution network: passive splitters and the PON loss budget |
| `validation.js` | cabling-feasibility rules engine |
| `net.js` | pure IPv4 / MAC / subnet helpers, zero dependencies |
| `table.js` | the one console table renderer: column widths measured from the data, never typed in |
| `ipv6.js` | pure IPv6 addressing, prefix and neighbour-discovery helpers |
| `iface-name.js` | one port, many spellings — front-panel vs console names |
| `abbrev.js` | unambiguous keyword abbreviation — the IOS rule |
| `flow.js` | transport flows: a conversation, not a probe (TCP state, MSS, UDP headers) |
| `latency.js` | how long a packet is actually on the wire |
| `convergence.js` | how long each control-plane process takes to finish |
| `segment.js` | where a DHCP exchange happens, as a graph walk rather than a packet flood |
| `dhcp.js` | DHCPv4 pool + lease model |
| `dns.js` | authoritative zone model, resolver and answer cache |
| `nat.js` | static, dynamic and PAT translation |
| `acl.js` | Cisco-style standard/extended access control lists |
| `vlan.js` | pure IEEE 802.1Q membership and frame classification |
| `stp.js` | 802.1D spanning-tree election, as a pure graph problem |
| `lag.js` | LACP / LAG aggregation model |
| `vrrp.js` | VRRP (RFC 5798) group maths, as a pure function |
| `ospf.js` | OSPF adjacency + shortest-path-first, as a pure graph problem |
| `bgp.js` | BGP-4 session FSM, peer validation and best-path selection |
| `scion.js` | SCION addressing and path selection |
| `ra.js` | Router Advertisement (ICMPv6 134) / Router Solicitation (133) |
| `lldp.js` | the protocol that exists to answer "what is plugged into this port" |
| `portsecurity.js` | the switch's own answer to "which sources may I hear on this port" |
| `cli.js` | vendor-agnostic management console (Cisco-like, not Cisco-only) |

If you are looking for a protocol and it is not in that list, it is not in the engine — check
[SIMULATION.md](SIMULATION.md) before assuming otherwise, because the matrix names the absences
explicitly.

### Capabilities, not vendors

A `Device` has a list of **capabilities**; the enum is `CAPABILITIES` in `engine/device.js`, fifteen
entries. Three gate forwarding, five more are read, seven are labels — read in four places:

| Capability | Read by | Effect |
|------------|---------|--------|
| `host`, `l2-forward`, `l3-forward` | `device.js` — `isHost()`, `isL2()`, `isL3()` | the forwarding behaviour: terminate, bridge (MAC learning, flooding, VLAN tagging, STP), or route |
| `poe-pse`, `poe-pd` | `media.js` — `isPoePse()`, `isPoePd()` | whether a device is treated as sourcing / drawing power when its ports are derived |
| `cli`, `dhcp-server`, `http-server` | `flow.js` — `SERVICE_PORTS` | which TCP/UDP ports a flow can terminate on: SSH/Telnet 22/23, DHCP 67, HTTP/HTTPS 80/443 |
| `nat`, `firewall`, `wireless`, `dhcp-client`, `vlan`, `lacp`, `stp` | nowhere | labels only |

The seven labels are not "reserved for future protocol support" — the features they name already
work, driven by configuration and port hardware instead of a flag: NAT by `nat` rules, filtering by
`access-list` + `ip access-group`, DHCP client by `ip address dhcp`, VLANs by `switchport`, a LAG by
`channel-group`, STP by the `isL2()` predicate. See
[DEVICE_REGISTRY.md §Capabilities](DEVICE_REGISTRY.md#capabilities) for the full table.

The forwarding logic branches on those three predicates, never on `vendor` or `model`. That's the
entire trick that makes **any manufacturer work**: a Huawei router and a Cisco router differ only by
their JSON spec.

### Forwarding decision (`simulator.js`)

1. **MAC learning** — record `srcMac → ingress interface`.
2. Is the destination MAC ours (unicast) or broadcast?
   - **L2 device** → bridge: known unicast → forward out the learned port;
     unknown unicast / broadcast → flood. (An L3-capable switch may also
     terminate frames addressed to its own MAC.)
   - **Host / router / firewall** → only act on frames addressed to us or
     broadcast; routers never flood broadcasts across subnets.
3. **L3 handling** — ARP (request → reply if we own the target IP; reply → cache
   + flush pending packets), or IP (dest = us → ICMP reply; otherwise route).

### Routing (`device.js: routeTo`)

Longest-prefix match first; equal-length prefixes are broken by administrative distance, in this
order:

| Source | Administrative distance |
|---|---|
| Connected subnet (interfaces with an IP) | 0 |
| Static route (`ip route`) | 1 |
| eBGP (routes learned from a peer in another AS) | 20 |
| OSPF | 110 |
| iBGP (same AS) | 200 |
| Default gateway (`ip default-gateway`, used by hosts) | 254 — and only consulted when nothing else matched |

A route yields an egress interface and a next-hop IP; the next-hop MAC is
resolved via the ARP cache or a new ARP request (packets are stashed in a
pending queue until the reply arrives).

### Why it's correct, not canned

- ARP requests actually **flood** the L2 segment and only the owner replies.
- MAC tables are **learned** from real traffic.
- Cross-subnet pings traverse the router with **TTL decrement** and correct
  L2/L3 header handling (source IP is preserved; only the MAC is rewritten).
- Unreachable destinations **time out** because the ARP request is never answered.

## The server

`server/index.js` is a dependency-free Node HTTP server that:

- serves the static frontend from `web/`,
- exposes a JSON REST API (`/api/...`),
- upgrades connections to WebSocket for live multi-client topology sync
  (`server/ws.js` is a minimal, hand-rolled RFC 6455 implementation).

`server/startup-error.js` is the third file, and it exists for one moment: the server not starting
is exactly when the UI's "Report a bug" button is unavailable. It maps `EADDRINUSE`, `EACCES` and
`EADDRNOTAVAIL` to a headline plus the commands that fix them, prints a `Report it:` line with a
pre-filled issue URL for the cases that are bugs rather than configuration (`reportable` is false
for the two permission/address ones), and falls back to `PacketForge failed to start: <error>` with
the advice to paste the whole terminal output. `describeListenError()` returns the parts and
`formatStartupError()` the lines, so a test can assert the wording without capturing stderr.

One hole worth knowing: `PORT` is `parseInt(process.env.PORT || '8000', 10)`, and `server.listen()`
throws **synchronously** for a bad port, before the `error` listener is attached. `PORT=abc`
therefore reaches the user as a raw `RangeError [ERR_SOCKET_BAD_PORT]` stack trace instead of the
friendly message, and `PORT=1.2.3.4` is truncated to `1` and starts the server on port 1 without a
word of complaint — which also means the `EADDRNOTAVAIL` branch cannot be reached by typing an
address into `PORT`. See [README.md](../README.md#if-it-will-not-start).

**What it listens on, and for whom.** `server.listen(PORT, cb)` passes **no host**, so the socket binds
every interface rather than loopback — measured on this machine, `GET http://<lan-ip>:8000/api/version`
answers `200` with the same payload as localhost. Nothing in the server authenticates, authorises or
rate-limits a request: the HTTP surface is the whole security model, and the WebSocket endpoint is bound by
the same rule. That is the intended shape for a lab tool on a trusted network and the reason
[PUBLIC-ACCESS.md](PUBLIC-ACCESS.md) exists for a deployment that is not on one — if you expose the port,
put something in front of it that authenticates, because the process will not.

### Error responses

Every failure is JSON with a human-readable `error` string, and the HTTP status carries the class:
`400` for a malformed body, `404` for an unknown endpoint, topology, device, interface or flow,
`405` for the wrong method, `409` for something the engine refused, `422` for a body that parses but
cannot be true (`state must be up or down`).

**With one exception, and it is the one a client polls.** An unknown device id is `404` on the calls
that act **on** a device — measured against a live server: `POST …/config/nope` →
`404 { error: 'device not found' }`, `POST …/ping` with an unknown `src` →
`404 { error: 'source device not found' }`, `POST …/interfaces/nope/Fa0/1` → `404 device not found` —
but `DELETE …/devices/nope` answers **`200`** with `{ ok: true, state }` and the state unchanged,
because deletion is defined as idempotent here (deleting the same id twice returns the same `200`, and
the second call learns nothing). Deleting on a board id that does not exist *is* a `404`
`topology not found`. So "delete returns ok" tells a client that the id is absent, never that it was
present.

**Several responses carry no `code` at all**, so do not parse `error` text and assume one is there.
The table below was taken from a live server, one request per row:

| Status | Code | When | Body |
|---|---|---|---|
| `400` | *(none)* | the body is not JSON | `{ error: 'invalid JSON body' }` |
| `400` | `E_BAD_REQUEST` | `POST …/link-options` without both device ids — **not** `POST …/links` | `{ code, reason: 'expected {a, b} device ids' }`, and note there is no `error` key at all |
| `404` | *(none)* | unknown endpoint, unknown device model | `{ error: 'unknown endpoint' }` |
| `404` | `E_NO_LINK` | `POST\|PATCH …/links/:id/state` for a link that does not exist | `{ error: 'no such link', code: 'E_NO_LINK' }`. **Not the only status for this code**: `PATCH …/links/:id` answers the same code as a `422` (see below) |
| `405` | *(none)* | any method but `POST`/`PATCH` on `…/links/:id/state` — the only 405 in the dispatcher | `{ error: 'use POST' }` |
| `422` | `E_BAD_STATE` | a link state that is not `up` or `down` | `{ error: 'state must be up or down', code }` |
| `422` | `E_BAD_LENGTH` | `PATCH …/links/:id` with a length that is not a positive number | `{ error: 'A cable length must be a positive number of metres.', code }` |
| `409` | the engine's code, `E_LINK` as fallback | a refused cable | `{ error, code, issues: [{ code, message }, …] }` |
| `409` | *(none)* | a device id that is already in use | `{ error: 'device id already in use', id, existing }` |

Two of those rows are worth reading twice. The `405` is **path-specific**: `POST /api/version`
answers `404 unknown endpoint`, not `405`, because the dispatcher matches on presence rather than
method. And **`POST …/links` does no shape validation at all** — it reads `body.a.deviceId`
directly, so a request with no `a` is caught by the generic refusal handler and answered `409
{ error: "Cannot read properties of undefined (reading 'deviceId')", code: 'E_LINK', issues: [] }`.
A `500` was avoided, but the message is a JavaScript TypeError, so a client that shows `error` to a
user will show them that string.

The refusal case is the one worth writing code against: `POST /links` answers `409` with
`{ error, code, issues: [{ code, message }, …] }`, where the codes are the physical-layer ones
catalogued in [PHYSICAL_LAYER.md](PHYSICAL_LAYER.md) (`E_MEDIA_NOT_SUPPORTED`,
`E_POLISH_MISMATCH`, `E_POE_BUDGET`, …). A duplicate device id is also a `409`, but its body is
`{ error, id, existing }` with no code at all — check `issues` for the first kind and `id` for the
second.

`POST …/validate-link` deliberately does **not** use an error status: it answers `200` with
`{ verdict, mediaOptions }`. The verdict is the raw `Topology.validateLink()` result —
`{ ok, errors[], warnings[], media, mediaId, speedMbps, patchCord, patchCordLossDb, polishWeakened,
patchCordOptions }` — so a UI can render "you cannot cable this" and still offer the media that
would have worked. Note the field names differ between the two surfaces: `validate-link` reports
`errors[]`/`warnings[]`, while a refused `POST /links` reports `issues[]`. Same engine codes, two
envelopes.

**It wants port objects, and a body of bare device ids is accepted with a green verdict.** Measured on
a 250 m `1000base-t` run between `d1/Gi0/0` and `d2/eth0`:

| Body | Answer |
|---|---|
| `{a:{deviceId:'d1',iface:'Gi0/0'}, b:{deviceId:'d2',iface:'eth0'}, lengthM:250}` | `200`, `warnings: [{code:'W_DISTANCE', message:'250 m exceeds the 100 m reach of 1000BASE-T between Router/Gi0/0 and PC/eth0.'}, {code:'W_COPPER_LONGRUN', …}]` |
| `{a:'d1', b:'d2', lengthM:250}` | `200`, `verdict.ok: false` with two `E_NO_PORT` errors and **`warnings: []`** |

That is the mirror of `link-options`, which takes the plain ids and answers with objects: the same two
strings are the right shape on one endpoint and the wrong one on the other, and neither refuses. A client
that passes ids here learns nothing about an over-long cable, because the warnings are computed from a
port it never resolved.

### Response headers and methods

Measured with a raw socket against a live server, because none of this is visible from the UI:

| Request | Status | Headers that matter |
| --- | --- | --- |
| `GET /api/version` | `200` | `Content-Type: application/json; charset=utf-8`, `Access-Control-Allow-Origin: *`, `Cache-Control: no-store` |
| `GET /` | `200` | `text/html; charset=utf-8`, `Cache-Control: no-store` |
| `GET /app.js`, `/style.css` | `200` | correct `Content-Type` per extension, `Cache-Control: no-store` |
| `GET /nope.js` | **`200`** | `text/html` — the shell, not a 404. Any path that is not under `/api/` falls back to the UI |
| `GET /api/nope` | `404` | JSON `{error}`, `Access-Control-Allow-Origin: *`, `no-store` |
| `OPTIONS /api/version` | `204` | `Access-Control-Allow-Methods: GET,POST,DELETE,OPTIONS`, `Access-Control-Allow-Headers: Content-Type` |
| `HEAD /api/version` | **`404`** | API routes do not answer `HEAD` — `GET` is `200` in the same second |
| `HEAD /` | `200` | the static branch does handle it |

Four consequences worth knowing:

- **`no-store` on every file and every API reply — but not on the shell fallback.** There is no build
  step, so `web/app.js` on disk is the code the browser runs; a cacheable asset would survive a pull
  and the UI would be stale with no hint. The one reply that leaves without the header is the
  catch-all shell at an unknown path: `GET /nope.js` above carries `Content-Type: text/html` and no
  `Cache-Control` at all, because that branch writes its headers by hand while the real-file branch
  beside it sets `no-store`. `/` and every file that exists are `no-store`, so a reload is the
  current tree — but a browser may cache the shell at a mistyped URL.
- **An unknown path is not an error outside `/api/`.** `/nope.js` answers `200` with the HTML shell,
  so a mistyped `<script src>` fails at parse time in the console rather than as a visible 404.
- **`curl -I` lies about API liveness.** `HEAD /api/version` is `404` while `GET /api/version` is
  `200`, so a monitor built on `curl -I` reports a healthy server as down. Use `curl -s -o /dev/null -w '%{http_code}'`
  with `GET`, which is what the README's liveness line does.
- **CORS allows four methods, and the API needs five.** The dispatcher accepts `PATCH` on
  `…/links/:id/state` (`POST` and `PATCH` share a branch), but the preflight advertises only
  `GET,POST,DELETE,OPTIONS` — and it answers the same fixed list whatever
  `Access-Control-Request-Method` asked for. A same-origin UI never notices; a browser client on
  another origin cannot send that `PATCH`, even though the server would accept it. `PUT` is not in
  the list because the API has none.

No response carries `Content-Length`: bodies are chunked, and the `204` preflight carries no body at
all.

### Live sync (WebSocket)

The socket carries **one** application message type, and it is the whole protocol:

| Direction | Message | Meaning |
|---|---|---|
| server → client | `{ type: 'topology', topologyId, state }` | the board as it is now — sent on connect, on `subscribe`, and after every mutation |
| client → server | `{ type: 'subscribe', topologyId }` | "send me that board"; silently ignored if no such board exists |

Three consequences worth knowing before you write a client:

- **On connect you get the `default` board, whether you wanted it or not.** There is no handshake
  parameter, so a client that cares about a named board must send `subscribe` and wait.
- **A mutation broadcasts to every client**, not to the subscribers of that board — `wss.broadcast()`
  loops over the whole client set. Filter on `topologyId` yourself or you will render somebody
  else's lab. Board *lifecycle* is the exception: `POST /api/topologies` and
  `DELETE /api/topologies/:id` call no `broadcast()` at all (measured with a decoded-frame client: a
  connected subscriber sees **zero** frames when a board is created or deleted), so a client that
  wants to notice a new board has to poll `GET /api/topologies`. The socket carries content edits.
- **A frame with no `state` must not be adopted.** The bundled UI carries that rule explicitly
  ("a socket frame without a state is not a board"), because adopting one blanks the canvas — that
  was issue #38, and it is the reason `state` is always included rather than being a diff.

Frames that are not valid JSON, or carry an unknown `type`, are discarded without a reply. At the
protocol level the connection is minimal RFC 6455: text frames, `close` (0x8) and `ping → pong`
(0x9/0xA). No compression, no fragmentation, no presence list — the server does not tell you who
else is connected.

Measured with a hand-rolled client, because "no reply" and "a reply you did not expect" look the same
if you only count bytes:

| Probe | Result |
|---|---|
| Upgrade on `/`, `/ws`, `/deep/path`, `/api/topologies`, `/api/version` | `101 Switching Protocols` on every path — the upgrade is not routed, so there is no "correct" URL |
| Handshake with no `Sec-WebSocket-Key` | **zero bytes**, socket closed — not a `400` |
| Handshake with `Sec-WebSocket-Version: 8` | **`101`** — the version is not checked either, so a client claiming an old draft still upgrades |
| Frames arriving unprompted, right after the handshake | **1** text frame (`{type:'topology', topologyId:'default', state}`). This was measured as **2** on an earlier tree and is one today — which is the point: a client must not hard-code the count |
| `{"type":"subscribe","topologyId":"default"}` | **1** frame back, same shape |
| An HTTP mutation while connected | **1** frame, the broadcast |
| Three junk frames (`{"type":"bogus"}`, `not json`, `{}`) | **0** frames back in 700 ms — discarded, no error frame |

Re-measured with a hand-rolled frame reader that decodes opcodes rather than counting `recv()` calls:
one text frame (opcode `1`) per event, no control frames, no empty frames. Subscribe first, filter by
`type`, and never assume the socket is quiet because you have not written anything yet — but also do
not assume it is noisy.

**The socket is not mounted at a path.** The `upgrade` handler runs before any routing, so `GET /`,
`/ws`, `/deep/path` and even `/api/topologies` all answer `101 Switching Protocols` — measured on
all four. The bundled UI uses `/`, and a client can use anything; there is no `/ws` to get wrong.

**A handshake without `Sec-WebSocket-Key` is closed with no HTTP reply at all.** `handleUpgrade()`
destroys the socket rather than answering `400`, so a client that forgets the header sees a
connection that opens and immediately closes with nothing to read — not the usual upgrade error.
If a hand-rolled client fails silently, check for that header before the framing.

Topologies live in an in-memory `Map` (one "default" board, plus named ones on demand) **and are
written to disk**, one JSON file per board in `data/topologies/<id>.json` — no database, no
dependency. `PF_DATA` relocates the whole data directory so a test can run against a scratch tree:
point it at `/tmp/x` and boards are written to `/tmp/x/topologies/<id>.json`, the parent only.
Writes go to a temporary file and are renamed into place, so a crash mid-write cannot leave a board
that the next boot refuses to parse; they are also immediate rather than debounced (a 120 ms
debounce was removed because on Windows a kill during the window lost the last edits). The saved
envelope carries `{format, version, savedAt, topology}` — the board is nested under `topology`, not
at the top level, and the nested object carries its own `{format, version, seq, devices, links, layout}`
(measured by creating a board, adding one device and reading the file:
`{"format":"packetforge-topology","version":1,"savedAt":"2026-11-10T18:10:50.587Z","topology":{"format":…,"version":1,"seq":…,"devices":[…],"links":[],"layout":{}}}`). `data/` is gitignored. All state is JSON-serializable, which is what makes
import/export and the "New" button trivial.

Two consequences worth knowing before you trust the file tree as a record of what exists:

- **A new board is not written until something changes on it.** `POST /api/topologies` with a name
  and nothing else leaves no file behind — the first device, cable or config edit creates it. So an
  empty board survives a restart only if it is not empty, and a directory listing is a list of
  boards that have been *edited*, not boards that have been *created*.
- **`DELETE` does not delete the file.** Measured: create `ghost`, add a device, `DELETE` it —
  `GET /api/topologies` reads `{"ids":["default"]}` while `topologies/ghost.json` is still on disk.
  Restart the server and the board is back: `{"ids":["default","ghost"]}` and
  `GET /api/topologies/ghost` answers `200`. Deleting is a forget-in-memory operation, so a board
  removed from the UI reappears on the next boot until the file is deleted by hand.

### Environment variables

`server/index.js` reads exactly three, and each changes something observable from outside the process. The fourth row is here because it looks like a server switch and is not one:

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `8000` | the listen port, through `parseInt(…, 10)` — `PORT=8010.9` listens on **8010**, and `PORT=abc` throws before the socket exists |
| `PF_DATA` | `data/` | relocates the data directory to `<PF_DATA>/topologies/` |
| `PF_COMMIT` | unset | copied verbatim into `/api/version`'s `commit` field |
| `PF_NO_OPEN` | — | **read by nothing.** Set to `1` in the child environment by `scripts/smoke-http.js` and never consulted: the server does not open a browser, so setting it changes nothing |

Measured on this tree: without `PF_COMMIT`, `GET /api/version` answers
`{"name":"packetforge","version":"0.1.0","commit":null,"node":"v26.12.1","platform":"win32/x64","devices":1661}`;
with `PF_COMMIT=abc123` the same call answers `"commit":"abc123"` and nothing else moves. **Nothing
in the repository sets it** — not the `Dockerfile`, not a script, not the npm scripts — so the
`commit` field the API table documents is `null` on every stock install and inside the container
unless you set it yourself.

A census of `process.env.*` across `engine/`, `server/`, `web/`, `scripts/` and `examples/` finds
**27** variables read — the three above plus 24 that belong to the tooling rather than the server:
`PF_REPO`, `PF_TOKEN`, `PF_API`, `PF_DEVICES`, `PF_INCOMING`, `PF_WIKI_REPO`, `PF_CLONE`, the
`PF_FORGEJO_*` family alongside a bare `FORGEJO_TOKEN`, `GH_REPO`/`GH_TOKEN`/`PF_GH_TOKEN_FILE`, the
`CF_*` group, and `PF_HOST`/`PF_OWNER`/`PF_PATH`/`PF_NAME`/`PF_PUBLIC_URL` that
`scripts/cf-access-bypass.js` needs. `PF_NO_OPEN` is not in that count at all: `scripts/smoke-http.js`
puts it in a child's environment and nothing reads it. Each script's header names the ones it reads;
none of them affect a running server.

### Board lifecycle

Four board endpoints, plus **three** outside `/api/topologies` — `GET /api/catalog`, `/api/version` and
`/api/media`, counted from the `parts[1] === …` branches in `server/index.js` (this sentence said "two
catalogue/build ones" and had been omitting `/api/catalog`, the one that returns `{ specs, categories }`).
Two of the board endpoints behave in a way a client author will not guess:

| Call | Answer |
|---|---|
| `GET /api/topologies` | `{ ids: [...] }` — the boards that exist |
| `POST /api/topologies` | `201 { id, state }`. Send `{ "id": "lab2" }` to choose the id; send nothing and you get `topo-<base36 timestamp>` |
| `GET /api/topologies/:id` | the board state, or `404 { error: 'topology not found' }` |
| `DELETE /api/topologies/:id` | `{ ok: true }` — **always**, even for an id that never existed |
| `GET /api/version`, `GET /api/media` | build info (`name`, `version`, `commit`, `node`, `platform`, `devices`) and the raw media/cage catalogues |

- **Adding a device wants `vendor` + `model`, ignores `name`, and says neither.** `POST
  /api/topologies/:id/devices` with `{ "kind": "pc", "name": "PC1" }` answers
  `{"error":"unknown device model: undefined/undefined"}` — no 400, no field list, the two words
  `undefined/undefined` being the missing pair. With the right pair
  (`{"vendor":"generic","model":"generic-pc","name":"PC1"}`) the device arrives as **`PC-d1`**: `name` is
  dropped, the label comes from the catalogue and the id from the board, exactly as `name` is dropped on a
  board. To actually name it you have to *configure* it, and `hostname` only works inside config mode —
  `POST …/config/d1` with `{"commands":["configure terminal","hostname PC1"]}` renames it to `PC1`, while
  `{"commands":["hostname PC1"]}` answers `% Unrecognized command: hostname PC1` and renames nothing. The
  config endpoint answers `404` for a device id that is not on the board.

  The two keys are `commands` (an array) and `command` (a string) — and **a body with neither is not
  rejected for its shape**. Measured: `{"lines":["show version"]}` answers
  `400 { error: 'CliSession.run expects a string, got undefined' }`, which names the engine's internal
  call rather than the mistake the client made. If you get that message, your key is not `commands`.
- **A `200` from the config endpoint means the request ran, not that the device accepted it.** The
  session starts in exec mode, so a bare `interface Gi0/0` is not a command there, and the refusal
  arrives inside a `200`. Measured on a fresh board:

  ```
  POST …/config/d1   {"command":"interface Gi0/0"}
  200 {"output":"Router-d1>interface Gi0/0\n% Unrecognized command: interface Gi0/0",
       "prompt":"Router-d1>", …}
  ```

  The status code is the same one a successful call returns; the tells are the `%` line and the prompt
  the answer ends in (`Router-d1>` is exec, `Router-d1(config-if)#` is the interface). Prefix with
  `enable` and `configure terminal`, and check the `output` for `IP address set on Gi0/0: …` rather
  than trusting the code. A client that treats `200` as "applied" builds a lab with no addresses and
  only finds out from the next call — `POST …/flows` answers
  `400 { error: 'destination device has no IP address', code: 'E_NO_ADDRESS' }`, which names the
  symptom rather than the call that caused it.
- **An id is taken verbatim, and an id the URL cannot carry makes an orphan board.** Nothing validates
  the `id`: `..`, `../escape`, `a/b`, `has space`, `.hidden`, `CON`, eighty characters and non-ASCII all
  answer `201`. Then the dispatcher splits the path and **does not percent-decode the segment**, so a
  board whose id needs encoding can never be opened again — `GET /api/topologies/has%20space` answers
  `404 { error: 'topology not found' }` while `GET /api/topologies` cheerfully lists `"has space"` in
  `ids`. An id of `..` cannot even be attempted: the URL normalises to `/api/devices` and the server
  answers `404 unknown endpoint`. If you let a user name boards, encode the id yourself and keep it to
  characters that survive a path segment.
- **Creating a board is idempotent, and never `409`.** `POST /api/topologies` with an id that already
  exists answers `201` and returns the board as it stands: devices, links and `seq` untouched, no
  write, no wipe. Re-creating `b1` after adding a device left `devices = 1`, `seq = 2` in memory, in the
  `201` body and in `data/topologies/b1.json` — measured all three.
- **Two ids that "work" write awkward files.** `.hidden` creates `.hidden.json` (a dot-file that
  `ls *.json` and most globs skip) and `CON` creates `CON.json`, a Windows reserved device name that
  happens to succeed here; both were reachable and writable when measured, so this is a footgun
  rather than a refusal.
- **`name` is not a field.** Posting `{ "name": "lab2" }` returns `201` with an id of
  `topo-mw9ltb2h` and creates a board you did not name. Measured against a live server, because the
  body is not validated and the mistake is silent.
- **Delete is idempotent, unauthenticated and not durable.** Two clients deleting the same board
  both get `{ ok: true }`; the second one learns nothing from the response — and neither of them
  removed anything from disk, so the board returns after a restart (see above).

### Everything else under `/api/topologies/:id`

The board endpoints above are the ones a client needs first, and for a long time they were the only
ones written down — which meant the UI's actual client surface was undocumented. The full set is
**eleven namespaces under `parts[3]` — `config`, `devices`, `flows`, `interfaces`, `layout`,
`link-options`, `links`, `load`, `ping`, `reset`, `validate-link` — carrying eighteen call
signatures** in **fifteen dispatcher blocks**, plus the board-level routes above and the three catalogue
routes below.

Counted from the dispatch block in `server/index.js` rather than by eye, because the shape is not what
the namespace list suggests. **25 callable method-path pairs over 15 namespaces**, and the three blocks
that carry more than one method account for the whole gap:

| Namespace | Pairs | Which |
|---|---|---|
| `links` | 4 | `POST` a link, `DELETE …/:linkId`, the length edit (`PATCH` **or** `POST`), `…/:linkId/state` |
| `flows` | 4 | `GET` the list, `POST` to open one, `GET …/:flowId`, `DELETE …/:flowId` |
| `topologies` | 4 | `GET` the id list and `POST` to create one; `GET …/:id` and `DELETE …/:id` |
| `devices` | 2 | `POST`, `DELETE …/:devId` |
| the other eleven | 1 each | `catalog`, `version`, `media`, `validate-link`, `link-options`, `config`, `interfaces`, `ping`, `layout`, `load`, `reset` |

Counting methods naively gives **26**, not 25: the length edit accepts `PATCH` *or* `POST` on the same
path, and the table below lists it once. Three facts this arithmetic hides and the dispatch block makes
obvious:

- **The method is not part of the route, so a wrong method is not a `405`.** `PUT /api/version`,
  `POST /api/catalog` and `DELETE /api/version` all answer `404 {"error":"unknown endpoint"}`. The one
  exception is `…/links/:linkId/state`, which answers `405 {"error":"use POST"}` for any other method —
  it is the only `405` in the dispatcher, and the table below says so.
- **A nested path of the wrong depth is a `404` that echoes itself**: `…/links/l1/extra` answers
  `{"error":"unknown endpoint: /api/topologies/t/links/l1/extra"}`, while the top-level `/api/nope`
  answers the bare `{"error":"unknown endpoint"}`. Two different 404 bodies from one dispatcher.
- **`/api` without the trailing slash is not an API path at all.** The dispatcher tests
  `urlPath.indexOf('/api/') === 0`, so `GET /api` falls through to the static handler and returns the
  **UI, `200` with HTML**, while `GET /api/` returns `404 unknown endpoint`. A health check pointed at
  `/api` is checking the wrong thing and passing.

Four of those traps in one paste, against a server on the default port and the default board — each line
is the answer measured on this tree, so a run that differs is a change in behaviour rather than a typo:

```bash
B=http://localhost:8000
curl -s -o /dev/null -w '%{http_code}\n' -X PUT    $B/api/version        # 404 — wrong method is a 404, not a 405
curl -s -X PUT $B/api/topologies/default/links/l1/state                  # 405 {"error":"use POST"} — the only 405
curl -s -o /dev/null -w '%{http_code}\n' $B/api                         # 200, HTML — the UI, not an API path
curl -s $B/api/topologies/default/links/l1/extra                         # 404 echoing the path back in full
```

Per namespace:

| Call | Answer |
|---|---|
| `POST …/devices` | `{ device, state }`; `404` for an unknown `vendor`/`model`, **`409`** when a client-supplied `id` is already taken (with the existing device named, so the UI can say which) |
| `DELETE …/devices/:devId` | `{ ok, state }` — also drops that device's console sessions |
| `POST …/links` | `201 { link, state }`; **every** refusal is `409` — `E_LINK` for a port already patched, an unknown interface or an unknown device id, `E_SELF_LINK` for both ends on one device. `E_PORT_IN_USE` is not one of them: that code belongs to `validate-link`, see the measured table below |
| `DELETE …/links/:linkId` | `topo.disconnect()` — `{ ok, state }` |
| `PATCH` (or `POST`) `…/links/:linkId` | `{ ok, link, warnings, state }` — sets `lengthM`, `422` with the code when the length does not suit the medium |
| `POST …/links/:linkId/state` | pull a cable or put it back — see [LINK-STATE.md](LINK-STATE.md), including the duplicate-`state` wart |
| `POST …/validate-link` | the mating verdict for a candidate pair (`200` even when nothing fits, so the UI keeps the explanation) |
| `POST …/link-options` | which media could join two **devices** — `{a, b}` are plain device-id strings, not `{deviceId, iface}` objects, and the answer carries the port `pairs` it would use. `lengthM` changes the `warnings` inside each option. See the measured block below |
| `POST …/config/:devId` | runs console commands: `{ commands: [...] }` or a single `command`, plus optional `atMs`; answer is `{ output, lines, prompt, runAtMs, convergence, device, state }`. The `state` half exists because returning only output once left the UI's `topo = r.state` undefined and blanked the board (issue #38) |
| …and it answers at an instant | `atMs: <ms>` asks every command in the request at that instant, `"converged"`/`null`/absent means settled. `runAtMs` echoes it back (`null` = settled) and `convergence` is the same schedule the cable endpoint returns, so a caller can see *what* has not finished. Applied on every request rather than when the session is created: a cached session that pinned the instant of whoever created it answered the next caller about a moment they never asked for (issue #1335) |
| …and a bad instant is refused by name | `atMs: -5`, `atMs: "later"` and `atMs: "5s"` all answer **400** with `{ "error": "atMs must be a non-negative number of milliseconds, \"converged\", or absent", "code": "E_BAD_INSTANT" }` — `instantFrom()` accepts a non-negative number, `converged`/`infinity`/`inf` in any case and surrounding whitespace, or nothing at all. `"converged"` is a 200. This is the one refusal code in the API that the CLI appendix does not carry, because no console command can raise it |
| …and it shares the board's counters | the console runs on the topology's flow table **and** its per-port counter map, so the traffic it generates is visible from `/flows`; it used to build its own `Simulator`, one board with two accountings and no way to tell which one you were reading (issue #1335). The two views are fed by one model but print different numbers — see the row below before reading either as a total |
| …and the two views it feeds print different numbers | One model, two counters, and they do not agree. Measured on `lab2`, three console `ping 10.0.2.20` runs that each answer `4/4`: `show interfaces` on **d1** climbs `6 packets, 664 bytes` → `11 / 1264` → `16 / 1864` (6 on the first run, **5 per run after it**), while `runtime.d1.counters` climbs `4 / 4` → `8 / 8` → `12 / 12` — **four packets per run and no bytes at all**: `bytesIn` and `bytesOut` stay `0` because only `/flows` feeds them. So read `show interfaces` for what crossed the wire and `runtime[id].counters` for what the flow layer opened and refused; do not expect one to explain the other, and do not read a `0` byte count there as "nothing was sent" |
| …and it remembers the mode | The session is kept per `topology:device`, so two calls do **not** start fresh: send `configure terminal` in one and the next begins at `(config)#`, where `enable` is refused as unrecognised. Send `exit` (or the whole sequence at once) rather than assuming a new prompt |
| `POST …/interfaces/:devId/:iface` | direct property edit — `ip` (with `mask`), `enabled`, `description`, `role`. A role the hardware does not offer is refused with the reason rather than stored; **no address-conflict check, IPv4 only** — see the measured table below |
| `POST …/ping` | `{ events, replies, success, step, runtime }` — a *new* `Simulator`, so a ping never inherits a stale queue |
| `GET …/flows` | `{ flows: [...], counters }` — every recorded flow and the per-device byte/packet counters. On a board where nothing has been opened this is `{ flows: [], counters: {} }`, an empty object rather than a zeroed table |
| `POST …/flows` | `{ proto, src, dst, dstPort, bytes }` (or `srcDevice`/`dstDevice`, and `dstIp` to aim at an address). `201 { flow, mtu, mss, segments, events, step, counters, runtime }` — `flow.state` is `established`, `bytesDelivered` totals what arrived, `openedStep` says which step in the run the handshake completed on |
| `GET …/flows/:flowId` | `{ flow }`, or `404 { error: 'flow not found' }` — also for an id the client only ever saw in a **refusal**: a refused flow is reported in the `POST` body and never stored, so fetching it afterwards 404s |
| `DELETE …/flows/:flowId` | `{ ok: true, flow, already, events, step, counters, runtime }` with `flow.state` now `closed`. Deleting twice is a `200` with `already: true`; a made-up id is `404 { error: 'no such flow: <id>', code: 'E_NO_FLOW' }`, so "already closed" and "never existed" are different answers |
| `POST …/layout` | `{ ok }`; accepts `{ positions: { <devId>: {x,y} } }` and ignores ids that are gone |
| `POST …/load` | `Topology.fromJSON(body)` replaces the board wholesale and clears its sessions — **with no validation at all**, see the measured table below the API surface |
| `POST …/reset` | `{ ok }`; clears MAC tables, ARP caches, pending queues **and** flow state, because a conversation pointing at a NAT translation that no longer exists is worse than no conversation |
| `GET /api/catalog` | `{ specs, categories }` — the device catalogue the palette and inspector read, plus the same specs pre-grouped by `category` (`{ router: [...], switch: [...] }`, **25** keys today). The grouping is not the top ten only: `loadCatalog()` sorts by `CATEGORY_ORDER` (router, switch, l3-switch, firewall, ont, host, server, wireless, ptp, cloud) and gives anything unlisted order 99, so the grouped object comes out in that order with the remaining fifteen categories — `camera`, `laptop`, `olt`, `iot`, `nas`, `nvr`, `tap`, `splitter`, the legacy `ap` and the rest — trailing, alphabetical by `vendor/label` |

**A refused flow leaves no record and still leaves a translation.** Measured on a NAT overload router:
`POST …/flows` answers `400 {code:'E_REFUSED', reason:'connection refused: nothing listening on
203.0.113.9:80'}` with `flow.id` in the body, `GET …/flows/<id>` is `404`, and `GET …/flows` is empty —
the record really is not stored. The router, however, keeps the mapping: `show ip nat translations`
lists `tcp 203.0.113.1:1024 192.168.1.10:49152 203.0.113.9:80 203.0.113.9:80 pat` afterwards. Two
consequences: a lab can hold NAT state for conversations that never opened, and the inside-global port
counter moves on. A second host through the same pool gets `203.0.113.1:1025`, while **repeating the
same 5-tuple** reuses `:1024` — three refused attempts from one host left exactly one translation.


**`link-options` takes device ids, and a port-shaped body fails at `200`.** The overlay in the UI asks
about a device pair and gets the pairing back, which is why the input is not the shape the other cable
endpoints take:

| Body | Answer |
| --- | --- |
| `{"a":"d1","b":"d2"}` | `200 {ok:true, a:{id,name,model,vendor}, b:{…}, options:[…], refusals:{}}` |
| `{"a":{"deviceId":"d1","iface":"Fa0/1"}, "b":{"deviceId":"d2","iface":"eth0"}}` | **`200 {ok:false, code:'E_NO_DEVICE', reason:'no device [object Object]'}`** — not a `400`, and the object is stringified into the message |
| `{"a":"d1"}` | `400 {code:'E_BAD_REQUEST', reason:'expected {a, b} device ids'}` — note the **missing `error` key**, which is the tell this is the shape check and not a refusal |
| `{"a":"zz","b":"d2"}` | `200 {ok:false, code:'E_NO_DEVICE', reason:'no device zz', options:[], refusals:{}}` — unknown ids are a `200`-level failure too |
| `{"a":"d1","b":"d2","ifaceA":"Fa0/1"}` | extra keys are ignored; there is no way to ask about **one port pair**, only a device pair |

Each entry in `options` is
`{id, key, media, mediaId, mediaName, family, speedMbps, maxRangeM, warnings, pairs, ports}`, and `pairs`
is the port-level answer: `[{a:{iface,cage,label}, b:{…}}]`. Passing `lengthM` does not change how many
options come back — it changes their `warnings`, so the same device pair at 5 m and at 250 m differs in
content rather than in length.

`PATCH …/links/:id` changes the **length** of an existing cable, and it is the one place where the same
code wears two statuses. Measured on a live link:

| Call | Answer |
| --- | --- |
| `PATCH …/links/:id` `{"lengthM":300}` | `200`, the cable is now 300 m |
| `{"lengthM":0}`, `{"lengthM":-5}`, `{"lengthM":"abc"}` | `422 {error:'A cable length must be a positive number of metres.', code:'E_BAD_LENGTH', state:{…}}` — the error carries a **whole topology snapshot** in `state` |
| `{"lengthM":null}` | `200` and the length is **cleared** back to unset — `null` means "no length", not "bad length" |
| `{}` | `200`, a no-op |
| `PATCH …/links/nosuch` | **`422 {error:'No such link: nosuch.', code:'E_NO_LINK', state:{…}}`**, while `POST …/links/nosuch/state` answers **`404`** with the same `E_NO_LINK` |

`POST|PATCH …/links/:id/state` is small and strict: `{"state":"up"}` or `{"state":"down"}` answers
`200 {ok:true, linkId, state}`, and **anything else** — `{"state":"sideways"}`, `{"up":false}`, an empty
body — answers `422 {error:'state must be up or down', code:'E_BAD_STATE'}`. `DELETE …/links/:id`
answers `200 {ok:true, state}` and is idempotent: deleting the same cable twice is a second `200`.

**Cabling: one counter, `409` for everything, and the warnings only exist on the other endpoint.**
Measured on a fresh board:

- **Device and link ids share a single sequence.** Three devices are `d1`, `d2`, `d3`; the first cable
  then becomes **`l4`**, the next device `d5`, the next cable `l6`, the one after that `l7`. A client
  that assumes `l1` for the first link, or counts links separately, is wrong — and the ids are not
  re-used, they just keep climbing.
- **The link object is bigger than `{a, b}`.** `201` returns
  `{ id, a, b, type, mediaId, speedMbps, duplex, lengthM, lagId, patchCord, state }`; on copper with no
  optics chosen the server picks `mediaId: "1000base-t"`, `speedMbps: 1000`, `state: "up"` itself.
- **Every refusal is `409`, including ids that cannot exist.** `E_SELF_LINK` for both ends on one
  device (`Switch (L2) cannot be cabled to itself (Fa0/2 to Fa0/2).`), but also `409 E_LINK` for
  `Unknown device: zz` and `Unknown interface Fa9/9 on d1` — never `404`, and the `issues` array that
  accompanies `E_SELF_LINK` is empty for `E_LINK`.
- **`validate-link` and `POST /links` do not agree, and the difference is a whole class of cable.** A
  250 m run of `1000base-t` gets `ok: true` from `validate-link` with two **warnings**
  (`W_DISTANCE`: *250 m exceeds the 100 m reach of 1000BASE-T*; `W_COPPER_LONGRUN`: *exceeds the 90 m
  horizontal-run limit*). `POST /links` then creates it as `state: "up"` and the response carries
  nothing but `{link, state}` — no warnings, no issue list. The same asymmetry shows on a patched port:
  `validate-link` reports `ok: false` with `E_PORT_IN_USE`
  (`Switch (L2)/Fa0/1 is already connected to d2/eth0.`), while `POST /links` answers
  `409 { code: 'E_LINK', error: 'd1/Fa0/1 is already connected' }`. If you want the diagnostics, call
  `validate-link` **first**; the connect call will not pass them back.

**`POST …/interfaces/:devId/:iface` is a footgun in four small ways, and nothing validates the board
as a whole.** Measured against a live board with two PCs:

| Body | Answer |
| --- | --- |
| `{"ip":"10.0.0.1","mask":"255.255.255.0"}` | `200`, applied |
| `{"ip":"10.0.0.2"}` | `400 {"error":"mask required with ip"}` |
| `{"ip":"999.1.1.1","mask":"255.255.255.0"}` | `400 {"error":"Invalid IPv4 address: 999.1.1.1"}` |
| `{"ip":"10.0.0.3","mask":"255.0.0"}` | `400 {"error":"Invalid IPv4 address: 255.0.0"}` — a bad **mask** reported as an address |
| `{"mask":"255.255.255.0"}` | `200` and **silently ignored** — the address is unchanged. There is no "set the mask alone" operation |
| `{"enabled":"false"}` | `200` and the interface stays **enabled**: the value is `!!body.enabled`, and the string `"false"` is truthy. Send a JSON boolean |
| `{"description":42}` | `200`, stored as the number `42` — nothing coerces it to a string |
| `{"ip":"","mask":""}` | `200`, address cleared |
| `{"role":"wan"}` on a fixed-role port | `400 {"error":"eth0 cannot be wan; it has no configurable role"}` |

Two more things this endpoint does **not** do:

- **It is IPv4 only.** There is no `ip6` key; a v6 address is set through the console
  (`ipv6 address …`), not here.
- **It does not check for an address already on the board.** Two PCs on the same board were both given
  `10.0.0.9` and both answered `200`. Nothing objects later either: `validateTopology()` in
  `engine/validation.js` collects **link** issues (`collectIssues(linkIssueList, …)`) and reports a
  board of duplicate addresses as `{"ok":true,"errorCount":0,"warningCount":0,"issues":[]}` — measured
  by calling it directly. And it is not reachable over HTTP in any case: `grep -rn validateTopology
  server/ web/` is empty, so the eleven namespaces expose per-link checking (`validate-link`) but no
  "is this board sane" call. Duplicate addressing is invisible until a ping answers from the device you
  did not mean.

**`POST …/load` validates nothing, and a bad body is a successful wipe.** Measured against a live
board holding two devices:

| Body | Answer |
| --- | --- |
| `{}`, `{"topology":null}`, a bare state object, or `{"topology":{…}}` | `200 {ok:true}` — the board is **replaced with an empty topology**, and that empty state is written to `data/topologies/<id>.json`, so the lab you had is gone from disk as well as from memory. All four shapes are accepted |
| `{"format":"not-a-topology", …}` | `200` — `format` is never checked |
| `{"version":99, …}` | `200` — `version` is never checked |
| `{"devices":{}}` | `400 {"error":"devices is not iterable"}` — the **only** refusal, and it names an internal operation rather than the mistake |
| a device whose `vendor`/`model` are not in the catalogue | `200`, and the device exists: `label: "nope"`, `name: "nope-d1"`, and `show version` answers `PacketForge nope (nope nope)` with an empty capability list. A later `ping` from it answers `404 {"error":"source device not found"}` |
| a link whose `b` names a device that is not on the board | `200`, and the link is **dropped silently** — an import can lose cables and still report `ok: true` |

So the status code tells you the request ran, not that the topology survived. To know an import worked,
read `state` out of the response and compare it with what you sent: count devices, count links, and
check every `vendor`/`model` against `GET /api/catalog` first. If you want a payload you can trust,
generate it from the engine the way `examples/build-examples.js` builds its four labs, rather than
hand-writing JSON.

> **The 25th category has no filter.** `/api/catalog` groups all **25** `category` values, but the type filter in
> the palette is built from `CAT_ORDER` in `web/app.js`, which lists **24** — `ap` is the one missing, and it is not
> an empty category: 11 models carry it (`fs/AP-N506`, `fs/AP-N506H`, `fs/AP-N516`, `fs/AP-N716`, …). Those devices are
> in the catalogue, in `/api/catalog` and in search results; they simply have no *Access point* entry in the type
> filter, so `paletteFilter.type` can never equal `'ap'`. Adding `ap` to `CAT_ORDER` and `CAT_LABELS` is a two-line
> change in the UI's own tables, not a catalogue change. Checked with:
>
> ```bash
> node -e '
> const {loadCatalog, groupByCategory} = require("./devices/registry");
> const c = loadCatalog(require("path").resolve("devices"));
> const g = groupByCategory(c);
> console.log(Object.keys(g).length, "groups;", (g.ap || []).length, "in ap");'
> ```

A refused flow is a `400`, and the body is worth reading in full: `{ error, code, reason, flow,
events, step }`, where `code` is the same `E_NO_ROUTE` / `E_ACL_DENY` / `E_UNREACHABLE` / `E_STP` the
console prints, `events` is the timeline entry that explains it, and `flow` is either the record that
failed (`state: 'reset'`) or `null` when nothing was ever opened. An unknown device is also a `400`
but carries no `code` at all — `{ error: 'Unknown source device: ghost' }` — so a client that switches
on `code` treats it as an unclassified failure.

**The link body is nested, and getting it wrong reports the wrong thing.** `POST …/links` wants
`{ a: { deviceId, iface }, b: { deviceId, iface }, mediaId?, lengthM?, duplex?, lagId?, patchCord?,
type? }`. Send the flat `{ a: 'srv', b: 'pc' }` a client author reaches for first and the server
answers `409 { error: 'Unknown device: undefined', code: 'E_LINK', issues: [] }` — a status that reads
like "these ports will not mate" when the truth is that it never parsed a device id at all. A real
mating refusal arrives the same way (409 with `code` and `issues`), so read the message, not the code.

There is deliberately **no `GET …/links`**: the cable list rides in `state.links` of every reply
that carries `state`, so listing them separately would go stale the moment it was cached. Anything
else under a known board id answers `404 { error: 'unknown endpoint: <path>' }`, which is
worth knowing when a client 404s: the board exists, the route does not.

### Transport flows

A ping proves a path carries one packet; a flow proves it carries a conversation.
`engine/flow.js` is the data model (header arithmetic, an MSS derived from the
path MTU, a small TCP state machine, and what each device listens on) and
`Simulator.openFlow()` drives it through the same forwarding path a ping uses, so
every SYN and every segment can be ACL-denied, NAT-translated or left unpowered.
The console reaches the same call as `flow open <dst> [port <n>] [bytes <n>]
[proto tcp|udp] [sport <n>]`, and `show flows` / `show flows <id>` /
`show flows counters` read the same table back — the API below and the CLI are two
doors onto one model, not two implementations.

- `POST /api/topologies/:name/flows` — `{ proto, srcDevice, dstDevice, srcPort, dstPort, bytes }`
  (`src`/`dst` are accepted as aliases for the two device fields). `201` with
  `{ flow, mss, mtu, segments, events, step, counters, runtime }`; `400` with
  `{ error, code, reason, flow, events, step }` when the flow could not open (`E_NO_ADDRESS`,
  `E_NO_ROUTE`, `E_ACL_DENY`, `E_POE`, `E_REFUSED`, `E_UNREACHABLE`, ...). `step` is the simulator's frame
  counter at the end of the run, which is what you compare against `events`.
- `GET /api/topologies/:name/flows` — `{ flows, counters }`.
- `GET /api/topologies/:name/flows/:id` — one flow, or `404` if it is gone.
- `DELETE /api/topologies/:name/flows/:id` — four-way close (FIN, FIN-ACK, ACK), `200` with
  `{ ok, flow, already, events, step, counters, runtime }`. Closing twice is not an error:
  `already: true` says the conversation was over.

Per-device `bytesIn/bytesOut/packetsIn/packetsOut` ride along in
`state.runtime[deviceId].counters`, so throughput can be drawn without a second
call. The flow table belongs to the topology and dies with it (`/reset` clears it
too).

## The UI

`web/` is vanilla JavaScript + SVG with **no build step** — load it and it works.

- `canvas.js` — SVG rendering, pan/zoom, drag-to-move, port cabling, packet
  animation. Geometry is computed in a first pass so links can attach to ports.
- `app.js` — state, REST client, palette, inspector (device/config/console/
  simulate), context menus, keyboard shortcuts, WebSocket sync.
- `faceplate.js` — the device drawn as hardware: one cell per port, in the order the
  front panel uses, with cage family and what is plugged in. The canvas still draws
  port dots; the **inspector** uses the panel, because 48 unlabelled dots cannot say
  which socket is which.
- `style.css`, `faceplate.css`, `index.html` — the app chrome, the panel's own
  styles, and the single page. No bundler, no framework, no build step.

The faceplate is a self-contained module with a two-call contract, which is why the
inspector and the canvas can both use it without sharing state:

```js
// app.js, inspector: the second argument is the topology, so cables and LLDP
// neighbours can be drawn on the panel
wrap.innerHTML = window.PFFaceplate.render(device, { topology: topo, fullNames: true });
window.PFFaceplate.bind(wrap, function (hit) { /* port clicked */ });   // delegated, no inline JS
```

`opts.topology` (the older name `opts.ctx` is still accepted — the module reads
`opts.topology || opts.ctx`) is what lets the panel mark a port `cabled` rather than `up` and name
its LLDP neighbour. That neighbour comes from frames, so it appears only after a run — the same
"a table the data path writes is empty until frames cross it" rule the `show` commands follow.
`opts.fullNames` prints the interface name instead of the panel number when it fits (the inspector
asks for that; the canvas does not), and `opts.width` overrides the **316 px** default — 12 px of
padding a side, so a panel is 316 px before its own padding is taken. Row width comes from
**measured** label text rather than a fixed column count, so a dense panel gains rows instead of
clipping glyphs; issue #26 was an eight-wide cage group cutting `Gi1/1/1` through the middle of a
character.

### Using the editor

Every binding below is in the code, not in a manual — this table is the manual. The status bar
carries the same hint while you work (`Scroll to zoom · drag to pan · click a device or cable to
inspect · click a port to cable`).

| Input | Does |
|---|---|
| wheel | zoom towards the pointer (1.12× in, 0.89× out, clamped 0.25–3) |
| drag background | pan |
| drag a device | move it |
| click a device or cable | select and inspect |
| click a port, then another port | cable them — the length/medium dialog takes over |
| double-click a device | select it and open its **console** tab |
| right-click a device or cable | context menu (cable: *Take link down* / *Bring link up*) |
| `c` | arm or disarm link mode — the hint becomes `Create link: click the first device  ·  Esc to cancel`, two spaces each side of the dot, because the status bar is set from the same string — and it is ignored while you are typing in a field, along with `Ctrl`/`Cmd`/`Alt`+`c` |
| `Esc` | cancel the placement, the in-flight cable or link mode; in a field, it just blurs |
| `Delete` / `Backspace` | delete the selected device or cable (`preventDefault`, because Backspace also navigates back in some browsers) |
| `Enter` | commit — in the cable-length box (`#link-length`, inside the link-options overlay), in the ping destination (`#ping-dst`), and in the console, where it is the **form** that submits: `#console-form` is a `<form>`, `#console-prompt` is only its label, and the handler clears `#console-input` before running the line |

Two zoom implementations exist and they currently agree: the toolbar's `+`/`−` call
`PFCanvas.zoomBy(f)`, *Fit* calls `fitView()`, and the wheel in `canvas.js` does its own arithmetic —
but all three clamp to the same **0.25–3**. Only the wheel zooms towards the pointer; the buttons
zoom the whole view.

### One colour per cable family, and the cables that get none

The canvas colours a cable by matching its media id against an ordered rule list in `canvas.js`
(`MEDIUM_RULES`), and the palette carries the matching legend so a copper patch lead and a fibre uplink
are tellable apart at a glance. There are nine families and the rule list is **first match wins**:

| class | matches a media id starting with (or containing) |
|---|---|
| `wireless` | `wireless…` |
| `dac` | `dac…` |
| `aoc` | `aoc…` |
| `pon` | `gpon`, `xgspon`, `xg-pon`, `epon`, `10g-epon`, `ngpon`, `pon` |
| `coax` | `docsis`, `moca`, `coax` |
| `dsl` | `vdsl`, `adsl`, `shdsl`, `dsl` |
| `powerline` | `homeplug`, `g.hn`, `powerline`, `mains` |
| `copper` | `…base-t`, `…-t`, `cat<n>`, `rj45` |
| `fiber` | `…base-`, `optics`, `fiber`, `fibre`, `sx`, `lx`, `er`, `sr`, `fr`, `dr`, `lr4`, `cr4`, `base-x` |

**Twenty-eight of the 89 media match none of them** and are drawn with no family class, so they appear in
the default slate stroke (`.link { stroke: #3c4a63 }`) and have no legend entry. The groups, checked by running the same rules over
`Object.keys(MEDIA)`:

- all **16 Fibre Channel** media — `2gfc-sw` … `128gfc-lw`. Fibre Channel *is* fibre, but no rule mentions
  `fc` or `gfc`, so these cables are not drawn as fibre and cannot be.
- all **6 console** media — `console-rs232` and its `19200`/`38400`/`57600`/`9600` variants, plus
  `usb-console`. A console cable has no physical family in the model, and none is invented for it.
- **`ghn`** and **`ghn-25`** — the rule looks for `g.hn` with the dot, and the media ids have none.
- **`lte`**, **`lte-a`**, **`5g-sub6`**, **`5g-mmwave`** — cellular has no class; the `wireless` rules match
  `wireless…` ids only, so radio links that are not Wi-Fi fall through as well.

Adding a tenth family means touching three files, which is why the fall-through is documented rather than
silently patched: the rule list and `mediumClass()` in `canvas.js`, the `.link-*` rules in `style.css`, and
the legend in `app.js`.

### What the UI remembers, and what it forgets

The browser keeps **exactly one** thing across a reload, and it is a preference rather than lab state:
whether the cable-colour legend is collapsed, under the `localStorage` key `pf.cableLegend.collapsed`
(`'1'` means collapsed). The read is wrapped because a private-mode browser throws on `localStorage`
access — a UI preference is not worth a crash — and everything else is rebuilt from the topology on load:
zoom, pan, selection, palette filters and the console scrollback all reset.

Device positions look like an exception and are not one. They are saved **server-side**, one `POST` per
drop to `/topologies/<id>/layout`, so the coordinates live in the topology JSON and come back with it; a
second browser sees the same layout, which a `localStorage` position could never give you. That request is
allowed to fail silently — the handler is an empty `catch (e) {}` — so a move still applies locally and
simply will not survive a reload. (The inspector's **call into** the faceplate carries the comment
`/* a layout failure must not cost you the port list */`, at `web/app.js:1032`, where it guards
`window.PFFaceplate.render()` so a broken panel cannot take the port list down with it. `web/faceplate.js`
itself contains no `try` and no `catch` at all, and this layout POST has no comment either.)

The legend itself is generated from `CABLE_FAMILIES` in `app.js`, and each swatch carries the **same class**
the canvas puts on the drawn cable (`link-copper`, `link-pon`, …), so the key and the drawing cannot drift
apart without the legend drifting with it.


## Adding a feature

The seams are deliberate. To add a new **protocol**, extend the simulator's `_tryProcessL3` and the
local handler it dispatches to — `_handleLocalIp` for IPv4, `_handleLocalIp6` for IPv6 — then add the
CLI command that configures and shows it. (Control-plane protocols do not need the packet path:
OSPF, BGP and STP are computed in their own modules and read back by `routeTo()` / the frame
path.) To add a new **device**, drop a JSON file in `devices/`. To add a new **UI panel**, touch
`web/`. Each layer changes independently.
