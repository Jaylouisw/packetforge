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
line, so it can be checked against the source rather than trusted — with three honest exceptions, found
by comparing every row to `head -3 engine/<file>.js`: `convergence.js` opens its header at the 802.1D
defaults, `segment.js` at the broadcast-domain tagging rule, and `scion.js` with the acronym before the
purpose on the next line. Those three rows paraphrase the header's intent; the other twenty-nine are
the header line itself.

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

### Error responses

Every failure is JSON with a human-readable `error` string, and the HTTP status carries the class:
`400` for a malformed body, `404` for an unknown endpoint, topology, device, interface or flow,
`405` for the wrong method, `409` for something the engine refused, `422` for a body that parses but
cannot be true (`state must be up or down`).

**Several responses carry no `code` at all**, so do not parse `error` text and assume one is there.
The table below was taken from a live server, one request per row:

| Status | Code | When | Body |
|---|---|---|---|
| `400` | *(none)* | the body is not JSON | `{ error: 'invalid JSON body' }` |
| `400` | `E_BAD_REQUEST` | `POST …/link-options` without both device ids — **not** `POST …/links` | `{ code, reason: 'expected {a, b} device ids' }`, and note there is no `error` key at all |
| `404` | *(none)* | unknown endpoint, unknown device model | `{ error: 'unknown endpoint' }` |
| `404` | `E_NO_LINK` | `POST\|PATCH …/links/:id/state` for a link that does not exist | `{ error: 'no such link', code: 'E_NO_LINK' }` |
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
  else's lab.
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
| Upgrade on `/`, `/ws`, `/deep/path`, `/api/topologies` | `101 Switching Protocols` on all four |
| Handshake with no `Sec-WebSocket-Key` | **zero bytes**, socket closed — not a `400` |
| **Frames arriving unprompted, right after the handshake** | **2** — so a client must not treat the first frame it reads as the answer to what it just sent |
| Three junk frames (`{"type":"bogus"}`, `not json`, `{}`) | **0** frames back in 800 ms — discarded, no error frame |

That second row is the one that costs an afternoon: subscribe first, filter by `type`, and never
assume the socket is quiet because you have not written anything yet.

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

### Board lifecycle

Four board endpoints (plus two catalogue/build ones), and two of them behave in a way a client
author will not guess:

| Call | Answer |
|---|---|
| `GET /api/topologies` | `{ ids: [...] }` — the boards that exist |
| `POST /api/topologies` | `201 { id, state }`. Send `{ "id": "lab2" }` to choose the id; send nothing and you get `topo-<base36 timestamp>` |
| `GET /api/topologies/:id` | the board state, or `404 { error: 'topology not found' }` |
| `DELETE /api/topologies/:id` | `{ ok: true }` — **always**, even for an id that never existed |
| `GET /api/version`, `GET /api/media` | build info (`name`, `version`, `commit`, `node`, `platform`, `devices`) and the raw media/cage catalogues |

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

Counted from `server/index.js` rather than by eye, because the shape is not what the namespace list
suggests: `links` carries **four** (`POST` a link, `DELETE` one, the length edit, and `…/:linkId/state`),
`flows` also carries **four** (`GET` the list, `POST` to open one, `GET` one, `DELETE` one), `devices` two
(`POST`, `DELETE`), and the remaining eight namespaces one each. The 18-versus-15 gap is entirely three blocks that
answer more than one method (`links` on `…/:linkId` does three, `flows` does two in each of its blocks);
counting methods naively gives 19, and counting the length edit's `PATCH` *or* `POST` as one call — which
is how the table below lists it — gives 18.

Per namespace:

| Call | Answer |
|---|---|
| `POST …/devices` | `{ device, state }`; `404` for an unknown `vendor`/`model`, **`409`** when a client-supplied `id` is already taken (with the existing device named, so the UI can say which) |
| `DELETE …/devices/:devId` | `{ ok, state }` — also drops that device's console sessions |
| `POST …/links` | `{ link, state }`; refusals carry the validation code (`E_LINK`, and `E_PORT_IN_USE` for a port that is already patched) |
| `DELETE …/links/:linkId` | `topo.disconnect()` — `{ ok, state }` |
| `PATCH` (or `POST`) `…/links/:linkId` | `{ ok, link, warnings, state }` — sets `lengthM`, `422` with the code when the length does not suit the medium |
| `POST …/links/:linkId/state` | pull a cable or put it back — see [LINK-STATE.md](LINK-STATE.md), including the duplicate-`state` wart |
| `POST …/validate-link` | the mating verdict for a candidate pair (`200` even when nothing fits, so the UI keeps the explanation) |
| `POST …/link-options` | which media could join two ports, optionally at a given `lengthM` |
| `POST …/config/:devId` | runs console commands: `{ commands: [...] }` or a single `command`, plus optional `atMs`; answer is `{ output, lines, prompt, runAtMs, convergence, device, state }`. The `state` half exists because returning only output once left the UI's `topo = r.state` undefined and blanked the board (issue #38) |
| …and it answers at an instant | `atMs: <ms>` asks every command in the request at that instant, `"converged"`/`null`/absent means settled. `runAtMs` echoes it back (`null` = settled) and `convergence` is the same schedule the cable endpoint returns, so a caller can see *what* has not finished. Applied on every request rather than when the session is created: a cached session that pinned the instant of whoever created it answered the next caller about a moment they never asked for (issue #1335) |
| …and it shares the board's counters | the console runs on the topology's flow table **and** its per-port counter map, so the traffic it generates is visible from `/flows`; it used to build its own `Simulator`, one board with two accountings and no way to tell which one you were reading (issue #1335). The two views are fed by one model but print different numbers — see the row below before reading either as a total |
| …and the two views it feeds print different numbers | One model, two counters, and they do not agree. Measured on `lab2`, three console `ping 10.0.2.20` runs that each answer `4/4`: `show interfaces` on **d1** climbs `6 packets, 664 bytes` → `11 / 1264` → `16 / 1864` (6 on the first run, **5 per run after it**), while `runtime.d1.counters` climbs `4 / 4` → `8 / 8` → `12 / 12` — **four packets per run and no bytes at all**: `bytesIn` and `bytesOut` stay `0` because only `/flows` feeds them. So read `show interfaces` for what crossed the wire and `runtime[id].counters` for what the flow layer opened and refused; do not expect one to explain the other, and do not read a `0` byte count there as "nothing was sent" |
| …and it remembers the mode | The session is kept per `topology:device`, so two calls do **not** start fresh: send `configure terminal` in one and the next begins at `(config)#`, where `enable` is refused as unrecognised. Send `exit` (or the whole sequence at once) rather than assuming a new prompt |
| `POST …/interfaces/:devId/:iface` | direct property edit — `ip` (with `mask`), `enabled`, `description`, `role`. A role the hardware does not offer is refused with the reason rather than stored |
| `POST …/ping` | `{ events, replies, success, step, runtime }` — a *new* `Simulator`, so a ping never inherits a stale queue |
| `GET …/flows` | `{ flows: [...], counters }` — every recorded flow and the per-device byte/packet counters. On a board where nothing has been opened this is `{ flows: [], counters: {} }`, an empty object rather than a zeroed table |
| `POST …/flows` | `{ proto, src, dst, dstPort, bytes }` (or `srcDevice`/`dstDevice`, and `dstIp` to aim at an address). `201 { flow, mtu, mss, segments, events, step, counters, runtime }` — `flow.state` is `established`, `bytesDelivered` totals what arrived, `openedStep` says which step in the run the handshake completed on |
| `GET …/flows/:flowId` | `{ flow }`, or `404 { error: 'flow not found' }` — also for an id the client only ever saw in a **refusal**: a refused flow is reported in the `POST` body and never stored, so fetching it afterwards 404s |
| `DELETE …/flows/:flowId` | `{ ok: true, flow, already, events, step, counters, runtime }` with `flow.state` now `closed`. Deleting twice is a `200` with `already: true`; a made-up id is `404 { error: 'no such flow: <id>', code: 'E_NO_FLOW' }`, so "already closed" and "never existed" are different answers |
| `POST …/layout` | `{ ok }`; accepts `{ positions: { <devId>: {x,y} } }` and ignores ids that are gone |
| `POST …/load` | `Topology.fromJSON(body)` replaces the board wholesale and clears its sessions |
| `POST …/reset` | `{ ok }`; clears MAC tables, ARP caches, pending queues **and** flow state, because a conversation pointing at a NAT translation that no longer exists is worse than no conversation |
| `GET /api/catalog` | `{ specs, categories }` — the device catalogue the palette and inspector read, plus the same specs pre-grouped by `category` (`{ router: [...], switch: [...] }`, **25** keys today). The grouping is not the top ten only: `loadCatalog()` sorts by `CATEGORY_ORDER` (router, switch, l3-switch, firewall, ont, host, server, wireless, ptp, cloud) and gives anything unlisted order 99, so the grouped object comes out in that order with the remaining fifteen categories — `camera`, `laptop`, `olt`, `iot`, `nas`, `nvr`, `tap`, `splitter`, the legacy `ap` and the rest — trailing, alphabetical by `vendor/label` |

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
  `{ error, code, reason, flow, events, step }` when the flow could not open (`E_NO_ROUTE`,
  `E_ACL_DENY`, `E_POE`, `E_REFUSED`, `E_UNREACHABLE`, ...). `step` is the simulator's frame
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

## Adding a feature

The seams are deliberate. To add a new **protocol**, extend the simulator's `_tryProcessL3` and the
local handler it dispatches to — `_handleLocalIp` for IPv4, `_handleLocalIp6` for IPv6 — then add the
CLI command that configures and shows it. (Control-plane protocols do not need the packet path:
OSPF, BGP and STP are computed in their own modules and read back by `routeTo()` / the frame
path.) To add a new **device**, drop a JSON file in `devices/`. To add a new **UI panel**, touch
`web/`. Each layer changes independently.
