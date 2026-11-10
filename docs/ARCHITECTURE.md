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

### Capabilities, not vendors

A `Device` has a list of **capabilities**:

| Capability | Meaning |
|------------|---------|
| `host`     | terminates packets, answers ARP + ICMP |
| `l2-forward` | bridge/switch: MAC learning + flooding |
| `l3-forward` | router: forwards IP between subnets |
| `cli`      | exposes the management console |
| `dhcp-server`, `dhcp-client` | **live** — `Simulator.computeDhcp()` runs the exchange before the first packet (#1051) |
| `nat`, `firewall`, `wireless`, `http-server` | reserved for future protocol support |

The forwarding logic branches on capabilities, never on `vendor` or `model`.
That's the entire trick that makes **any manufacturer work**: a Huawei router
and a Cisco router differ only by their JSON spec.

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

Longest-prefix match over, in order:

1. **Connected** subnets (interfaces with an IP).
2. **Static routes** (`ip route`).
3. **Default gateway** (`ip default-gateway`, used by hosts).

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

Topologies are kept in memory (one "default" topology, plus named ones on
demand). All state is JSON-serializable, which is what makes import/export and
the "New" button trivial.

### What is on the disk

One JSON file per board, in `PF_DATA/topologies/` (`~/.packetforge` unless the environment says otherwise). No
database, no dependency. Five rules, each of which a bug taught:

* **a change is saved before the answer is sent.** `broadcast()` is the one place that knows a board changed, and it
  saves synchronously. There is no debounce: on Windows a kill calls `TerminateProcess`, so no signal handler and no
  `exit` listener ever runs, and anything waiting on a timer is gone. A board is a few kilobytes and a human makes
  one change at a time;
* **a write is a temporary file and a rename,** so a crash mid-write cannot leave a half-written board that the next
  boot refuses to parse;
* **a created board is saved when it is acknowledged** — "make a board, name it, come back tomorrow" used to lose it,
  because the board lived in memory until something else happened to it;
* **the file name is injective.** `a b` and `a_b` both sanitise to `a_b.json`, so two boards shared one file: one of
  them silently overwritten on every save and gone at the next boot. When the sanitised form differs from the id, a
  short hash of the id is appended, and the id is written inside the file so the name never has to be reversed;
* **a file that is not a board is left alone, and said so.** `Topology.fromJSON()` is tolerant on purpose (it reads
  old files), but tolerance must not turn a corrupted save into an **empty board**: the operator would open the app
  and their lab would be gone, with nothing to read. The envelope is checked before anything is adopted, and the log
  line names the file.

A board's name is a name, so the path segment is percent-decoded before it is looked up — otherwise a board called
`a b` can be created and then never reached again.

### The live-sync socket

`server/ws.js` is a hand-written RFC 6455 server (about 140 lines, no dependencies) used for live multi-client
sync. It speaks one client message, `{"type":"subscribe","topologyId":"default"}`, and answers every message it
receives:

| message | answer |
|---|---|
| a new connection | `{"type":"topology", topologyId:"default", state:{…}}` |
| `subscribe` to a board that exists | that board, with its `verdicts` |
| `subscribe` to a board that does not | `{"type":"error", code:"E_NO_TOPOLOGY", topologyId}` |
| any other `type` | `{"type":"error", code:"E_UNKNOWN_TYPE"}` naming the one that exists |
| anything that is not JSON | `{"type":"error", code:"E_BAD_MESSAGE"}` |

Frames that are not allowed are refused with the code that says which rule broke: an **unmasked** client frame
(RFC 6455 §5.1) or a 64-bit length whose high word is not zero → `1002`; a frame over **1 MiB** → `1009`. A message
from this app is a JSON object naming a board, so the ceiling costs nothing and stops one client from asking the
process to buffer as much as it likes.

**A closed client is a closed client.** An upgraded socket has `allowHalfOpen = true`, so when the peer goes away it
emits `end` and *stops there* — `close` never fires. Removing the client only on `close` would leave a half-open
socket holding the entry for the life of the process; `end` and `error` count as gone too. `broadcast()` then only
ever reaches the living.

### What the static server answers

`web/` is four files served by `serveStatic()`, with three rules:

| request | answer |
|---|---|
| `GET /` or any path with no file extension | `index.html` (a deep link opens the app) |
| `GET /whatever.js` - a file that is not there | `404 text/plain`, never the document |
| `POST` / `PUT` / `DELETE` / `PATCH` | `405` with `Allow: GET, HEAD` |
| `HEAD` | the headers a `GET` would send, and no body - including when the response would have been gzipped |

The second row is the one that mattered: a missing asset used to be answered with `index.html` and a 200, so the
browser's only report was `Uncaught SyntaxError: Unexpected token '<'` in a file the reader could not identify. This
app has no client-side routes, so the fallback was hiding wrong filenames and serving nothing.

Containment is checked as a **path boundary** (`filePath === WEB_DIR || filePath.startsWith(WEB_DIR + path.sep)`),
not as a string prefix: `indexOf(WEB_DIR) === 0` also accepts a sibling directory called `web-backup/`. The URL
parser collapses `..` before the path is joined, which makes the difference unreachable over HTTP today - which is
precisely why the check must not depend on that.

### What a wrong request gets

Every endpoint that takes a body checks its shape before using it, and answers with a sentence and a status a
client can act on:

| request | answer |
|---|---|
| body that does not parse | `400`, "invalid JSON body" |
| body missing a required field | `400 E_BAD_REQUEST`, naming what was expected and what was missing |
| an id that does not exist | `404`, naming the id |
| content the engine refuses (an impossible cable, a bad link state) | `409` / `422` with the engine's own `code` |

Two rules, both learned the hard way:

* **a response never contains the runtime's own words.** A missing body used to be dereferenced straight through
  and came back as `Cannot read properties of undefined (reading 'trim')` — with a `400` on `/config` and a `409`
  on `/links`, because a missing body is apparently a conflict;
* **a rejected request changes nothing.** `POST /load` with `{"format":"x"}` used to replace the live board with an
  empty one and answer `ok: true`: silent data loss from a request that should never have touched anything. The
  document's envelope is now checked first (`format`, `devices`, `links`), and a document with neither `devices`
  nor `links` is refused rather than emptying the board. `Topology.fromJSON()` stays tolerant — it reads old files
  — but tolerance belongs to reading, not to replacing.

### Port names in URLs

A port name is not one path segment: `1/1/1`, `Fa0/1`, `Gi0/0/2`. `POST /api/topologies/:name/interfaces/:device/:port`
therefore takes **the rest of the path** as the name, and decodes it, so both of these reach the same port:

```
POST /api/topologies/default/interfaces/d1/1/1/5
POST /api/topologies/default/interfaces/d1/1%2F1%2F5
```

Until it did, the plain form split into extra segments and answered `404 unknown endpoint`, and the encoded form
answered `404 interface not found` - which meant the inspector's shutdown toggle did nothing at all on every port
named that way, and that is most of the catalogue. The control was rendered, wired, and inert; nothing in the
tests noticed because the tests drove the engine, not the URL.

### Transport flows

A ping proves a path carries one packet; a flow proves it carries a conversation.
`engine/flow.js` is the data model (header arithmetic, an MSS derived from the
path MTU, a small TCP state machine, and what each device listens on) and
`Simulator.openFlow()` drives it through the same forwarding path a ping uses, so
every SYN and every segment can be ACL-denied, NAT-translated or left unpowered.

- `POST /api/topologies/:name/flows` — `{ proto, srcDevice, dstDevice, srcPort, dstPort, bytes }`.
  `201` with `{ flow, mss, mtu, segments, events, counters, runtime }`; `400` with
  `{ code, reason }` when the flow could not open (`E_NO_ROUTE`, `E_ACL_DENY`,
  `E_POE`, `E_REFUSED`, `E_UNREACHABLE`, ...).
- `GET /api/topologies/:name/flows` — `{ flows, counters }`.
- `GET /api/topologies/:name/flows/:id` — one flow.
- `DELETE /api/topologies/:name/flows/:id` — four-way close (FIN, FIN-ACK, ACK).

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

### One source of position

The canvas keeps one table of where each socket is in world coordinates
(`portPos`, filled by `computeGeo()` during `render()`), and three things read it:
the cables that are drawn, hit testing, and the packet animation. Anything that
moves a box must keep that table true, or the picture and the behaviour drift
apart:

- **A packet travels socket to socket.** `animateEvents()` resolves each `frame`
  event's `fromIface`/`toIface` through `socketPoint()` — the same coordinates the
  cable is drawn along. Animating device centre to device centre (what it used to
  do) drew a dot that crossed empty canvas while the cable ran somewhere else, and
  after a drag it matched neither position (#1228).
- **A drag moves the cables with the box.** `dragPreview()` shifts the stored
  endpoints of the cables attached to the dragged device by the same delta, so a
  chassis cannot slide out from under its own cables during a drag.
- **A drag is redrawn on release.** `on.move()` persists the layout; the canvas
  then calls `render()` so the socket table and the drawing agree before the next
  ping, hit test or click.
- **`ensureGeoCurrent()` is the safety net**, run before an animation: if the
  layout has moved since the last render, geometry is recomputed and the cables
  redrawn rather than animating to a stale socket.

A device with no `layout` entry is drawn at a default position, and everything
that needs its coordinates takes them from that same drawing — no component
invents a position of its own.


## Adding a feature

The seams are deliberate. To add a new **protocol** (e.g. DHCP or TCP), extend
the simulator's `_tryProcessL3`/`_handleLocalIp` and add a CLI command. To add a
new **device**, drop a JSON file in `devices/`. To add a new **UI panel**, touch
`web/`. Each layer changes independently.
