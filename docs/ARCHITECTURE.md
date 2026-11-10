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
