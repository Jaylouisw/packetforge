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

### A saved board is the lab that was saved

`Topology.serialize()` writes each device's ports; `fromJSON()` reads them back. The two have one rule:

**every field of every port survives the round trip, for every model in the catalogue.**

That rule is tested, not assumed (`test/port-roundtrip.test.js`). It was not true: the reader rebuilt each port
from four keys — `{name, type, speed, cage}` — and re-derived the rest, so **322 of 2,015 devices** came back
different:

| lost on reload | ports | what it changed |
|---|---|---|
| `comboWith`, `comboRole` | 84 | a combo cage stopped knowing it was one cage, so two cables went into one physical position |
| `hardware.maxSpeedMbps` | 1,028 | a 115.2 kbps console reloaded as a 1 Gbps port, inventing a speed-downgrade warning |
| `hardware.poeOutDeclared` | 1,499 | a port that declared its own PoE reloaded looking like the engine had guessed |

The reader now passes the whole port document through. Physical facts are not re-derived: `derivePortHardware()`
honours what the file states (`cage`, `poeOut`, `speedCaps`, `maxSpeedMbps`, `poeOutDeclared`, `maxRangeM`, …) and
only computes what is missing, which is what a spec needs and what a saved board does not.

### A `show` describes an instant, not a cache

The control planes are **results**: `computeStp()`, `computeVrrp()`, `computeOspf()` and `computeBgp()` each write what
they concluded onto the devices, and each honours `runAtMs`. A `show` command used to print whatever the last
computation happened to leave there, which meant:

* a console with no run behind it reported `(no O routes)` on a lab that was fully converged — the routes only appear
  if something ran the OSPF computation first;
* the answer to the same question depended on **which run happened before it**: `show ip route` at instant 5000 could
  print routes installed by a settled run 20000 ms later.

`CliSession._show()` now refreshes the control planes at the instant the session is standing at, before producing any
output — the same four computations the packet path already runs before it sends anything. Asking does not change the
configuration, and rows keep their distances and their `is directly connected` wording.

### The console over HTTP

`POST /api/topologies/:id/config/:devId` runs the console for a device: `{ commands: [...], atMs? }` in, the printed
lines plus the new state out. Three things it now does that it did not:

* **it shares the board's accounting.** The session used `new Simulator(topo)`, which brings its own flow state, so
  traffic counted by `/flows` was invisible to the console and traffic the console generated was invisible to the
  payload. Measured before the fix: 100 bytes of flow on a host's port and a payload that said `counted: false`. The
  console now prints exactly the counters the payload publishes.
* **it takes an instant.** `atMs` asks the question at that instant — the same `runAtMs` the CLI has always had — and
  the answer echoes `runAtMs` (`null` meaning "once everything has settled") plus `convergence`, like every other
  mutation. It is set on **every** request, not only when supplied, so a session cached by an earlier caller cannot
  pin a later one to an instant it did not ask for.
* **`show spanning-tree` recomputes before it answers.** `dev.stp` is written by whichever simulator computed it
  last; a console asked at 25000 printed the tree from an earlier pass at `Infinity` and called a port that was still
  listening "forwarding".

### Every change answers the same question

The HTTP API has five requests that change what the control plane will do — add a device, remove one, move a cable,
cut one out, and edit a port. Four of them answered with the new state and said nothing about convergence; only
`POST /links/:id/state` reported where the schedule stood. So an operator could ask "is this lab settled?" after
cutting a cable and not after disabling a port, which is the same question about the same board.

All five now answer through `noteChange()`, which attaches `convergence` (the engine's own `getConvergence()`), and
records the instant the caller says they are standing at when the request carries `atMs`. A request that does not name
an instant **leaves the clock alone** — moving it to 0 would claim the board changed before it did, which is a lie in
the other direction. A nonsense or negative `atMs` is ignored rather than recorded.

### The clock

Time in PacketForge is logical, never `Date.now()`. Three fields carry it:

| field | means | who moves it |
|---|---|---|
| `sim.runAtMs` | the instant a question is being asked at (`Infinity` = "once everything has settled") | `setRunTime()` |
| `link.stateSinceMs` | when this cable changed state | `setLinkState()` / `linkDown` / `linkUp` |
| `topo.lastChangeAtMs` | when the board last changed — the instant every convergence schedule is built from | `topo.markChange()` |

`markChange()` was only ever called for a cable, so shutting a port, enabling it, or moving it between VLANs left the
schedule built from an instant before the change. On a board that had already converged, `_stillConverging()`
answered 0 and a packet crossed a port that should have been listening. Every console command that changes the
forwarding decision now calls `_controlPlaneChanged()` → `Simulator.markTopologyChange()`, which records the instant
the operator is standing at. There is **one** answer to "when did the board change"; a second field on the simulator
(`reconvergeFromMs`) used to shadow it and nothing ever set it.

`lastChangeAtMs` is not saved. It is an instant in a run and a run ends: a board reopened tomorrow would build its
schedule from an instant belonging to a session that no longer exists. What is saved is the thing that happened — a
cable is down, and `stateSinceMs` says since when — and the clock is **derived** from the newest cable fault on the
way back in.

In the console, an instant is printed as an instant: `state: down, changed at 1200 ms (3800 ms ago)`. The old wording
(`since 1200 ms`) read as a duration and was wrong by the length of the run so far. With no run instant there is no
age to give, and an instant later than the run instant is marked `(not this run)` rather than given a negative age.

### Throughput: two counts, one shape

`runtime[d].counters` is `flow.counterSnapshot()`: always the same keys, always a copy, and `counted` says whether
anything has ever crossed the device. Two things it is worth knowing before reading it:

* **the device totals count transport payload, the port tallies count every frame.** `packetsOut` on a device is what
  its TCP/UDP flows carried; `ports["1/1/1"].packetsOut` is every frame that left that socket, ARP, LLDP and ICMP
  included. A switch that only forwards therefore has port tallies and zero device packets, which is correct and looks
  wrong until you know it.
* **a missing record is not a zero.** The engine creates a counter record on the first counted packet, so an untouched
  device has none; `counted: false` says so, and the numbers are still zeroes rather than absent fields. The payload
  used to give that device six keys and a busy one eight — `drops` and `ports` simply missing — so a client adding up
  drops read `undefined` on exactly the devices most likely to be idle.

### What the tables say

`show mac address-table`, `show arp` and `show lldp` each grew an honest note: the port an entry was learned on and
whether that port can still carry a frame — `(administratively down)`, `(down: peer shut down)`, `(vlan mismatch)`,
`(gone)`. That note is written once, in `Device.portCarrierNote()`, which reads `ifaceStatus()` (the same rule the
front panel and the console use for a port's state).

`Device.macRows(topo)`, `arpRows(topo)` and `lldpRows(topo)` return those rows as data, and both surfaces read them:
the console prints them, and `fullState()` publishes them as `runtime[d].mac`, `runtime[d].arpRows` and
`runtime[d].lldp`. The bare maps `runtime[d].macTable` and `runtime[d].arp` remain, and they are what they are — MAC
to port, address to MAC — because a client that only needs "which port" should not have to read rows. A stale entry
and a live one look identical in the bare map, which is why the rows exist.

One consequence worth knowing: a link state change **flushes** what was learned on that port, so `(down: link down)`
is unreachable in the MAC table by design — the entry is gone, not stale.

### Where the boxes are

`layout` maps device id to `{x, y}`: where each box sits on the canvas. Three rules, all learned by breaking them:

* **it is copied on the way out.** `serialize()` used to hand out `this.layout` itself, so the document the API, the
  UI and every fixture received *was* the board — move a box in the document and the lab moved.
* **a position belongs to its device.** `removeDevice()` used to leave the position behind; the server remembered
  to delete it and the engine did not, so a removal from any other caller left a box in the file that was not on the
  board.
* **a position is two finite numbers.** The canvas draws `pos.x` straight from the layout, so `{"x": "left"}` put a
  box at NaN with nothing to explain it. On load, a bad entry is dropped and reported (`E_LAYOUT_BAD_ENTRY`), a
  layout that is not a map is refused outright (`E_LAYOUT_MALFORMED` — `[]` is an object, and its positions were
  silently lost at the next save because JSON ignores an array's string keys), and a position naming a device the
  document does not contain is a warning (`E_LAYOUT_UNKNOWN_DEVICE`). Over the API, a bad position is a `400` before
  anything is stored.

And `0` is a coordinate. The API placed a device at `160,160` when asked for `0,0`, because `body.x || 160` treats
zero as missing — the one place on the canvas a box is most likely to be dragged to.

### A cable is restored or explained

Every option `connect()` accepts survives a save and reload (`mediaId`, `speedMbps`, `duplex`, `lengthM`,
`lagId`, `patchCord`, `state`, `stateSinceMs`, and the legacy `type` string), and `serialize()` hands out **copies**
of the endpoint records — writing to the document you were given must not adjust the board.

A cable that cannot be restored is not skipped in silence. `fromJSON()` records one entry per cable in
`loadIssues`, which every state payload carries next to `verdicts`:

| the document says | code |
|---|---|
| two cables share an id (links are kept in a map, so the second used to replace the first) | `E_LINK_DUPLICATE_ID` |
| a `state` that is not `up` / `down` / `blocked` | `E_LINK_BAD_STATE` |
| a port cabled to itself | `E_LINK_SELF_LOOP` |
| an end naming a device or port the document does not contain | `E_LINK_ENDPOINT_MISSING` |
| a cable the engine refuses (a port already connected, a cage already occupied) | `E_LINK_NOT_RESTORED`, with the engine's own sentence |

The HTTP API has always refused a bad link state (`422 E_BAD_STATE`); the load path accepted anything, so a
hand-edited or corrupted file produced a cable that `isUp()` said was not up and nothing else could explain.

A board written by an older version — without any of the newer keys — still loads, and its hardware is derived the
way it always was.

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

### Ping, and what a destination is

`POST /api/topologies/:name/ping` — `{ src, dst, count?, atMs? }`. `count` is a whole number from 1 to 50 (the
default is 4); anything else is a `400` with `code: "E_BAD_COUNT"`, because a count is a loop bound and one request
asking for a billion echoes is hours of engine time. The engine clamps as a backstop and reports both `count` (what
was sent) and `requestedCount` (what was asked for, `null` when nothing was asked).

`atMs` is the instant to ask at, in milliseconds, and it is the same question the console spells
`ping <address> at <ms>`: it is how a lab that is still converging can be asked "will this work in five seconds?".
A value that is not a time at or after 0 is a `400` with `code: "E_BAD_INSTANT"`. The answer reports `runAtMs`
— the instant it was actually given at — so an answer can never be mistaken for one about a different moment.

The ping runs on `simForFlows(topo)`, like the console: one board, one accounting. Its frames are counted in the
port tallies `/flows` reports, so a ping sent over HTTP and a ping typed into the console are visible in the same
place. (The device totals in `counters` are *flow* accounting — transport payload — so ICMP deliberately does not
move them; the port tallies are *interface* accounting and count every frame.)

`dst` is an **address or a hostname**; a name is
resolved through the lab's DNS servers before a single packet is sent, and the resolver's verdict rides back in the
answer:

```json
{ "events": [...], "replies": [{ "success": false, "reason": "dns-nxdomain" }],
  "success": false, "dns": { "ok": false, "status": "NXDOMAIN", "serverIp": "10.0.0.1" }, "runtime": ... }
```

`dns` is `null` when the destination was an address. A name that did not resolve is **not** 0% packet loss —
nothing was sent — so a client that only looked at `replies` would report the wrong thing; the `dns-noerror`-style
reason on the reply says which. A destination that is not a destination at all is a `400`:

```
POST /api/topologies/default/ping  {"src":"d1","dst":"10.0.0.999"}
400 {"code":"E_BAD_DESTINATION","error":"dst "10.0.0.999" is not an IPv4 address (four octets, each 0-255)"}
```

Until #1377 that string reached the engine, which threw, and the answer was a 500 — a mistyped octet presented as a
server fault. The same question is asked in three places, so it is asked once per surface and checked against the
others: `engine/cli.js` `_ping()` for the console, the endpoint above, and `web/app.js` `pingTargetProblem()` for
the inspector's Simulate tab (`test/ping-surface.test.js` compares them).

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
