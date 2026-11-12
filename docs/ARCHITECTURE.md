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
- MAC tables are **learned** from real traffic, and stamped with the instant they were learned, so an entry ages out
  after 300 s of silence (`MAC_AGE_MS`). The same aged lookup decides forwarding and reading: an entry the table
  only remembers is not a port a frame may be sent to. An entry with no timestamp — a fixture's, an imported lab's —
  is never aged and reports no age.
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
| `speedMbps` | any port with `speed <mbps>` | the forced line rate, added later and missed (#1405) |

The reader now passes the whole port document through. Physical facts are not re-derived: `derivePortHardware()`
honours what the file states (`cage`, `poeOut`, `speedCaps`, `maxSpeedMbps`, `poeOutDeclared`, `maxRangeM`, …) and
only computes what is missing, which is what a spec needs and what a saved board does not.

**A sweep over virgin labs cannot see a setting.** The first version of that test round-tripped a lab straight out of
the catalogue, so every field sat at its default and the comparison was default-in, default-out: it agreed with
itself about a file that carried nothing. `speedMbps` walked through that gap — `speed 100` was stored, printed by
`show interfaces` as `100Mb/s (forced)`, written to `show running-config`, and the port document never carried it,
so a saved lab came back at the hardware rate **and the command had gone from the config too**, which is what made
it permanent: nothing would put it back. The sweep now **configures** the port first (forcing the lowest supported
rate on one port of every model in the catalogue) and only then compares, which is the version of the claim the
section title makes.

Two conventions keep the document honest, and both are asserted: a field that is not set is **not written**
(`speedMbps`, like `natRole` and the combo fields, appears only when an operator set it — a board must not grow a
null line on every port in the catalogue), and a *cache* the file legitimately drops (`pvid`, which `classifyEgress`
derives on demand) is excluded from the comparison only because it is checked by behaviour instead: the reloaded
port has to classify into the same VLAN.

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

`runtime[d].macTable` is published as address -> port even though the table keeps `{ port, atMs }` internally: the
instant is not part of what that map has ever meant. The rows in `runtime[d].mac` carry an `age` per entry for a
client that wants it.

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

### A mask the console refuses is refused by every door

The console has been taught, one rule at a time, what an address is (#1411) and what a mask is (#1249). The HTTP
surface edits a port directly — `POST /api/topologies/:name/interfaces/:device/:port` with `{ ip, mask }` — and it was
asking different questions, because it used the *parsers* (`maskToInt()`, a conversion with no opinion) instead of the
rules. Two consequences, both reachable from the inspector:

```
POST {"ip":"10.5.5.1","mask":"255.0.255.0"}  → 200, and the port held a mask that is not a netmask
sw1#show running-config
ip address 10.5.5.1 255.0.255.0              ← a line the console itself refuses to type
sw1#show interfaces Gi0
  ip: 10.5.5.1/8                             ← and every surface read it as /8

POST {"ip":"10.5.5.1","mask":"24"}          → 200, and the port held the *string* "24"
                                             while the console stores "255.255.255.0" for the same command
```

The first is the one that matters: the board contained a configuration that **cannot be replayed from its own
configuration**. So the endpoint now asks `isIp()` and `isContiguousMask()` before it stores anything, refusing with a
sentence and a `code` the client can act on:

| the request says | answer |
|---|---|
| `ip` is not an IPv4 address | `400 E_BAD_ADDRESS`, `ip "300.1.1.1" is not an IPv4 address` |
| `mask` is not a run of ones then zeros | `400 E_BAD_MASK`, `mask "255.0.255.0" is not a netmask: a netmask is a run of ones then zeros (255.255.255.0, or 24)` |
| `ip` given without a mask | `400 E_BAD_MASK` |

A prefix length is accepted and rewritten to the dotted spelling before it is stored, because one intent has one
spelling in state — the console already did this, and the two doors disagreeing meant the same command produced
`"24"` through the API and `"255.255.255.0"` through the console. A refused request changes nothing.

### An address is restored or explained

`Device.hydrate()` copies the port document through, which is right — it is the lab that was saved. But the address on
a port is the one field the engine has rules about, and `POST /load` takes a whole document with no per-field
validation, so a hand-edited or older file could put a mask into state that no door would accept. Now `fromJSON()`
applies the same rule a cable gets: restored or explained, with one entry per port in `loadIssues`.

| the document says | what happens | code |
|---|---|---|
| `mask: "24"` (the old spelling) | rewritten to `255.255.255.0`; the address is kept | — |
| `mask` is not a run of ones then zeros | the port keeps no address | `E_IFACE_BAD_MASK` |
| `ip` is not an IPv4 address | the port keeps no address | `E_IFACE_BAD_ADDRESS` |
| `ip` with no `mask` | the port keeps no address | `E_IFACE_NO_MASK` |

A document holding one bad address loads — the rest of the lab is intact and the port is fixable in place — rather
than being refused wholesale, which is what happened before: the load answered `400 Invalid IPv4 address: 300.1.1.1`
and the board was never replaced. The message names the port and the value.

### A saved lab reopens with its conversations still in it

The flow table lives on the topology — it is runtime state of the board — but
`serialize()` never wrote it and `fromJSON()` never read it. So a lab with an
established TCP flow, saved to disk and reopened, came back with an **empty flow
table**: the reloaded board said nothing was connected while the document said a
conversation existed. One more surface that had the fact and one that did not (#1435).

Now `serialize()` writes `flows` (id, state, hops, counters) with the board, and
`fromJSON()` restores them. A document carrying a flow whose endpoints are **not on
the board** is refused the flow, not the board: it is reported in `loadIssues`
(`E_FLOW_GHOST_ENDPOINT`, naming the flow and the missing endpoints), exactly like a
cable that cannot be restored — and the board still opens. The id allocator is advanced
past any restored `flow-N` so the next flow cannot collide.

`test/flows-survive-save-load.test.js` pins it, 16 checks: the round trip (same id,
same state, same hops), no id collision, ghost endpoints reported and dropped, and an
empty board serializing `flows: []` rather than omitting the key.

### A frame that died named the door that was shut

`_forwardL2()` builds its flood candidates from the ports that can carry a frame, then
filters them — a port the tree blocks, a port outside the VLAN, a port that is the far
member of the port-channel the frame arrived on. When nothing was left it emitted **one
sentence whatever had refused**:

```
no egress ports in VLAN 1
```

On a switch whose only other port the spanning tree had blocked, that sentence is false
twice. The port *is* in VLAN 1, and the same box already answers `show spanning-tree`
with the truth:

```
Fa0/1         alternate     blocking   (traffic dropped)      <- show spanning-tree
Fa0/2 ...     1 drop (no egress ports in VLAN 1)               <- show interfaces, same frame
```

Two surfaces on one box, disagreeing, and the counter is the one an operator acts on: it
says VLAN, so the VLAN gets re-checked, and the VLAN was never the problem. It is also
the sentence `_lastDiscard()` hands to a failed `ping`, so the wrong words reach the
report as well as the counter.

Each refusal now names itself, because the three are three different answers:

```
no egress ports: spanning tree blocks Fa0/1
no egress ports: the only other port is a member of the ingress port-channel
no egress ports in VLAN 10            (kept: where the port really is outside the VLAN, this was always true)
```

Where the reason sits in `_lastDiscard()` did not move. Naming the tree does not make it
a different *kind* of cause — a tree block on a redundant path is not the reason a ping
failed, so ranking it with the port causes would have been a new lie in place of the old
one. The rank slot now matches both wordings (`no egress ports`) instead of only the VLAN
one, so the priority is the same as before the fix.

`test/flood-refusal-reason.test.js` pins it, 24 checks: the blocked port named by both
surfaces on the same box, the frame counted once rather than once per blocked candidate,
the payload filing it under the same sentence as the console, a genuine VLAN refusal
still saying VLAN, the hairpin naming the bundle, and the ranking unchanged.

### A route nobody could use read as installed

`routeNote()` asked which port a route leaves by, and when the answer was *none* it
returned no note at all — so the row was reported as healthy. On a router holding only
`10.0.0.1/24`:

```
r1(config)# ip route 192.168.50.0 255.255.255.0 172.16.9.1
r1> show ip route
S  192.168.50.0   /24  [1/0] via 172.16.9.1              <- no caveat: reads as an installed route
r1> ping 192.168.50.5
"no usable egress interface"                             <- the data plane could not use it at all
```

The table already knew how to say a row cannot carry anything — `(not installed: …)`,
`(administratively down (shut down))`, `(gone)` — but the one case where there is
**nowhere to send the packet** said nothing. And `Gateway of last resort is 172.16.9.1`
named a gateway no packet could reach.

The row is still printed, because it *is* configuration and `routeTo()` still finds it —
exactly like a connected route on a shut port — but it now carries the reason:

```
S  192.168.50.0   /24  [1/0] via 172.16.9.1  (no interface on the subnet of next hop 172.16.9.1)
S  192.168.50.0   /24  [1/0] via 10.0.0.99   (next hop 10.0.0.99 would leave by Gi0/0, which cannot carry: administratively down (shut down))
```

The two shapes are kept apart on purpose: a next hop no interface is on the subnet of is a
**routing** problem, a next hop whose port is shut is a **port** problem, and they send a
reader to different fixes. `egressCandidateFor()` answers the second question — which port
would carry this next hop if it could — because `egressFor()` only looks at ports that are
up, so a shut port's subnet used to read as "no interface at all".

The data plane's drop says the same thing, and names the destination it was routing to
(`no interface on the subnet of next hop 172.16.9.1 (route to 192.168.50.5)`), instead of
the sentence that named neither. `Gateway of last resort` no longer names an unusable
default; when a reachable one sits beside it, that is the one named.

`test/route-next-hop-unreachable.test.js` pins it, 27 checks: the row's note on both
surfaces, the counters filing the loss under the same sentence once, the gateway line
choosing the reachable default, a reachable next hop staying plainly healthy (and failing
as ARP silence, not as a routing problem), the shut-port and missing-port shapes, and the
ranking — an unreachable next hop now outranks silence and outranks a policy denial on a
device the packet never reached, because the frame never left this box.

### A blocked port was painted green

Three switches cabled in a triangle, and the tree must shut one port to keep the loop out.
The console said so plainly:

```
s1> show spanning-tree
Port          Role          State
Fa0/1         root          forwarding
Fa0/2         alternate     blocking   (traffic dropped)
```

The board drew `Fa0/2` exactly like `Fa0/1`: green, patched, healthy. The one rule all
three views ask — `portState()` in `web/faceplate.js` — knew about a shut port, an unplugged
socket, a link-down cable and a shut peer, and nothing about the tree. The state payload did
not carry the tree either, so no view *could* have known. An operator watching the canvas
while traffic died had one screen saying the port was fine and another saying the frames were
being thrown away.

The tree is now published, per bridge and per physical port, from the same computation the
console reads:

```json
"runtime": { "s1": { "stp": {
  "Fa0/1": { "state": "forwarding", "role": "root",       "blocked": false, "text": "forwarding" },
  "Fa0/2": { "state": "blocking",   "role": "alternate",  "blocked": true,  "text": "blocking (traffic dropped)" }
} } }
```

and `portState()` takes it as one more fact, in the same shape as the others:

| facts | verdict | text |
| --- | --- | --- |
| `enabled: false` | `down` | administratively down |
| `cabled: false` | `notconnect` | down (no cable) |
| `blocked: true` | `blocked` | blocking (traffic dropped) |
| `blocked: undefined` | `cabled` | up |

Three decisions worth keeping:

* **`blocked` is its own state, not `down`.** A redundant lab blocks ports by design; painting
  22 ports red on a healthy triangle would report a working tree as a broken board — the same
  trap `notconnect` avoids for empty sockets. It gets amber, which is the panel's "look here"
  colour, and red stays for real alarms.
* **Order matters and is asserted.** A shut port is reported shut even when the tree also
  blocks it; an unplugged socket is reported unplugged. Each fact keeps its own sentence.
* **An unknown tree is not a forwarding tree.** `stpVerdict()` answers `undefined` for a box or
  port the payload never mentioned, and `portState()` treats `undefined` as "nothing to say".
  A view given an older payload stays exactly as it was rather than inventing a verdict.

A port whose frames the tree drops could also be a **member of a bundle** the tree shut, so
the payload marks every physical member the tree blocked, not the logical port name — the
members are what the board draws.

`test/stp-port-state.test.js` pins it, 31 checks: the payload names the one blocked port in a
triangle and its role, the console row and the payload sentence match word for word, a router
publishes no tree at all, the four facts keep their own verdicts, `undefined` stays unchanged,
and the canvas and the inspector both route through the shared rule (checked statically, so
neither can quietly go back to asking `enabled` on its own).

### "No such port" was the answer to a question about a view

Twelve words that are views under `show interfaces` in IOS — `switchport`, `trunk`, `status`,
`description`, `counters`, `summary`, `capabilities`, `transceiver`, `errdisable`,
`flowcontrol`, `history`, `stats` — all answered the same thing:

```
s1> show interfaces switchport
% No interface switchport on Switch (L2)-s1
```

That is the sentence a mistyped port name gets, and it is the wrong lesson: the port is fine,
the **view** is not here. An operator who typed a command they know from IOS was told a socket
did not exist, so the next thing they check is the port name — which was never wrong. Worst of
all, `show interfaces ?` — how a reader asks what may go in that position — answered
`% No interface ? on Switch (L2)-s1`.

A word that is a keyword is now reported as one, and the refusal points at the command that
does answer the question:

```
s1> show interfaces switchport
% `switchport` is a view, not a port: this console has no `show interfaces switchport`.
  A port's own switchport line is in `show interfaces <port>`; VLAN membership is in `show vlan brief`.
```

Three rules the fix keeps:

* **The port table is asked first.** A device with a port genuinely called `status` still prints
  that port; the keyword table is consulted only after the name resolves to nothing.
* **Every command the advice names is run by the test.** Advice that does not run is another way
  of wasting the reader's time, so `show vlan brief`, `show version` and `show lldp neighbors`
  are executed and required to answer, not merely mentioned.
* **A near-miss on a real port is still a missing port.** `show interfaces Fa0/9x` keeps the
  `% No interface …` sentence: only the twelve view words take the new path, and `?`/`help` get
  a usage line instead of an error.

`test/show-interfaces-view-keywords.test.js` pins it, 71 checks: for each of the twelve words the
answer names it as a view, never as a missing port; the offered commands are executed; a bogus
port and a real port answer exactly as before; `?` and `help` print usage; case does not matter;
the words live in one named table and the console asks it; and the keyword check is after the
port lookup in the source, so a port named like a keyword still wins.

### A reason read on one console described another box

```
a> show ip route
Gateway of last resort is 10.1.1.1 to network 0.0.0.0
S*  0.0.0.0        /0  [254/0] via 10.1.1.1

a> ping 10.9.9.9
no route to 10.9.9.9                    <- printed on the host that HAS a route
```

The host sent to its gateway, the gateway had no route, and the gateway recorded the drop itself:

```
{"type":"drop","reason":"no route to 10.9.9.9","dev":"r1"}
```

`ping` handed the reader the drop's own words, and a reason is read on the console of whoever asked. So
the sentence was a claim about `a` — sitting three lines under `a`'s own default route. The event knew
who dropped it all along; the sentence did not.

A reason now names the box that recorded it **when that box is not the one the reader is at**:

| where the reader is | reason |
| --- | --- |
| `a`, whose gateway dropped it | `no route to 10.9.9.9 (dropped by r1)` |
| `a`, which itself has no route | `no route to 10.9.9.9` — no suffix: this *is* a statement about `a` |
| `r1`'s own counters | `device-wide 1 drop (no route to 10.9.9.9)` — a box does not name itself |
| `a`, whose frame a far switch refused | `switchport mismatch: … (dropped by s2)` |

The same words come out of both doors that report a dead path — `ping` and the flow open
(`E_NO_ROUTE`) — because both read their answer from the same event log and now pass it through the
same `_sayWhoDropped()`. Silent about a remote drop is not a neutral choice: it is a claim about the
local device, and it was false.

The suffix never moves the ranking of causes: with both a shut port at the source and an unreachable
gateway, the local shut port still wins and the gateway is not blamed for a frame that never left.

`test/reason-names-the-box.test.js` pins it, 18 checks: the host prints a default route and is still
not blamed; the gateway names itself nowhere in its own counters; a source with no route gets a bare
reason; a far switch is named exactly once; the flow door uses the same sentence; a successful run
invents no reason; and the ranking is unchanged.

### The answer that names a port nobody asked about

```
s1> show interfaces counters errors
% No interface counters errors on Switch (L2)-s1          <- claims a port is missing
s1> show interfaces counters
% `counters` is a view, not a port: …                     <- the *same* question, answered properly
```

The view-keyword table was keyed on the whole phrase, so `counters` was a view and `counters errors` —
the same question with the word a reader adds after it — fell through into the port lookup and came
back as a missing port. The same held for `status detail`, `switchport brief`, `summary detail` and
every other view word with anything after it. A reader is told to go looking for a typo in a port
name they never typed.

The phrase is now looked up whole, then by its first word, and quoted back verbatim so the reader
sees exactly which phrase was not a port. The port table is still consulted **first** (the source
order is asserted), so a device with a port genuinely called `status` keeps its port.

The other half of the same defect, one word away:

```
s1> show port-channel summary
% Invalid show command: port-channel summary
s1> show etherchannel summary                            <- the same table, other name
Group  Protocol          Ports
1      LACP              Fa0/1(P) Fa0/2(P)
```

`show port-channel` is how most of the world spells this table, and the console knew the word from
its own `channel-group` line. It is now the same door, not a second table, so the two spellings
cannot disagree — and a refusal underneath names **the command the reader typed**, not the one it was
rewritten into: being answered about `show etherchannel` after typing `show port-channel` reads as a
non sequitur.

`test/show-view-phrase.test.js` pins both, 48 checks: six view words with six different tails are
each reported as views, never as missing ports, quoting the typed phrase; the bare word and the
phrase point at the same place; a typo, a near-miss port and a real port all answer exactly as
before; the port lookup precedes the keyword lookup in the source; `show port-channel`,
`show port-channel summary` and `show port-channel brief` print *exactly* what their etherchannel
counterparts print on a lab with a live bundle; an argument is refused by the name the reader typed;
a device with no bundle gives the same sentence under both names; and all thirteen view words are
still views.

### The spellings IOS taught, on a console that has the views under other names

```
s1> show ip arp
% Invalid show command: ip arp
s1> show arp                                     <- the view was here the whole time
Protocol  Address          Age (min)  Hardware Addr     Interface
Internet  10.7.0.2         -          02:00:00:00:02:00 eth0
```

Thirty years of IOS put `show ip arp`, `show ip interface`, `show ip access-lists` and `show ip vrrp` in operators'
fingers, and every one of them was refused on a console that has each view under another name. `show ip` alone and
`show ip ?` were refused too, so there was no way to find out from the console what `show ip` can be followed by.

The console answers them now, and the way it does is the point:

| spelling | what happens |
| --- | --- |
| `show ip arp`, `show ip access-lists`, `show ip vrrp` | **rewritten** to `show arp`, `show access-lists`, `show vrrp` — same door, so the two spellings cannot drift apart |
| `show ip interface` (bare) | rewritten to `show interfaces` |
| `show ip interface brief` | **not** rewritten: it is a view of its own and keeps its own door |
| `show ip arp <address>` | rewritten with its argument, so the reader gets the useful refusal that says the whole cache is listed |
| `show ip protocols`, `show ip traffic` | no equivalent here, so the refusal names the commands that do answer the question |
| `show ip`, `show ip ?` | the list of what `show ip` can be followed by, ending at `help` |
| `show ip route <prefix>`, `show ip ospf neighbor`, `show ip nat translations`, `show ip dhcp binding`, `show ip bgp summary` | untouched: longer forms already have their own doors |

Three decisions worth keeping:

* **An alias, not a second implementation.** `show ip arp` and `show arp` print the same rows because they are the same
  code, so one cannot be fixed without the other. A parallel implementation would drift within a week.
* **Only the bare form is rewritten.** The obvious way to write this — map `interface` to `interfaces` wherever it
  appears — swallows `show ip interface brief` into `show interfaces brief`, which is not a view at all. The alias is
  keyed on arity for that reason, and the test reverts the guard to prove it.
* **A refusal names a command.** "Invalid" is the one thing a reader already knows. Where no equivalent exists the
  sentence names the commands that answer the question, and the test executes every one of them.

`show interfaces brief` had the same problem from the other side and joins the view-keyword table: `% \`brief\` is a
view, not a port: … \`show ip interface brief\` is the one-line-per-port view`.

`test/show-ip-spellings.test.js` pins it, 70 checks: every alias prints *exactly* what its target prints (compared
row for row, on a switch and on a router, with a resolved ARP row so an empty answer cannot pass); arguments are carried
through; `show ip interface brief` still differs from `show ip interface`; the six longer forms keep their own doors;
each pointer refusal is parsed for the commands it names and those commands are run; `show ip` and `show ip ?` list every
word the tables hold, and every word they promise is a command; `show interfaces brief` is a view that names a command
that answers; the redirect is checked to run before the first branch of `_show`; and `show arp` itself is unchanged.

### One cable, two answers about which VLAN a frame is in

Two switches joined by trunks whose native VLANs differ. Every check the board makes passes: the
medium is right, the speeds match, both ports are up, the distance is fine, `validateTopology()`
says `ok` with no warnings. And the traffic dies:

```
s2> show interfaces Fa0/1
  status: up, protocol: up
  1 drop (no egress ports in VLAN 10)          <- "no members in VLAN 10" on a box where the real
                                                  problem is the other end of this cable
s2> ping 10.9.0.2
"no ARP reply from 10.9.0.2"                   <- an inference, standing in for the recorded cause
```

`framesCompatible()` in `engine/vlan.js` has been the rule for *"do these two ports file a frame
the same way"* since the LAG rules landed, and its only caller was its own test. The two ends of a
trunk are exactly the pair it describes, so it is asked now — in the two places that can say
something:

| surface | before | now |
| --- | --- | --- |
| cable inspector (`validateTopology`) | no issues | `W_SWITCHPORT_MISMATCH` warning naming both numbers |
| the drop's reason | `no egress ports in VLAN 10` | `switchport mismatch: native VLAN 1 against native VLAN 10 on a trunk - the untagged frame was filed under VLAN 10 here, but s1 Fa0/1 sent it as VLAN 1, …` |
| `ping` | `no ARP reply from 10.9.0.2` | the recorded cause, because a mismatch is a fact and a missing reply is a conclusion |

Four decisions worth keeping:

* **A warning, not an error.** A trunk carrying no untagged traffic may legitimately disagree about
  the native VLAN. The cable is accepted; it says so. Refusing the cable would refuse a lab someone
  may be building on purpose.
* **One sentence, written order-independently.** `mismatchReason()` sorts the two numbers, so the
  cable inspector and the drop cannot describe the same cable with the digits the other way round —
  which is exactly what the first cut of this did, and what its own test caught.
* **The mismatch outranks "no ARP reply".** `_lastDiscard()` puts `switchport mismatch` above the ARP
  inference: a trunk that files frames differently is a recorded drop with one fix, while a missing
  reply is the conclusion drawn from it.
* **Only switchport pairs are checked.** A cable between two routed ports has no VLAN opinion and
  raises nothing.

`test/switchport-mismatch.test.js` pins it, 26 checks: the warning names both native VLANs and stays
a warning; matching trunks, matching access ports and routed cables raise nothing; access-VLAN,
trunk-against-access and allowed-list differences are each named (smallest first, so the phrasing is
canonical); the shared phrase appears verbatim in both the cable warning and the ping; the dropping
box counts exactly one drop under that sentence and says which end filed the frame under which
number; and a matching trunk is untouched.

### One state read shows both halves of one fact

`GET /api/topologies/:id` carries the board and each device's runtime tables. Two
runtime facts were missing from it:

- the **DHCP leases** — a client could read the board and see `a` holding `10.91.0.10`
  but not `r1`'s binding for the same address. The two halves of one lease, only one
  published. `/flows` had the flow table; `show ip dhcp binding` had the leases; the
  board payload had neither (#1433).
- the **flow table** — a flow opened and then a state read said nothing about it.

Now the payload carries `flows` (every conversation, with its `hops`) and
`runtime[id].dhcpLeases` (the same rows `show ip dhcp binding` prints, from the same
call). Because the lease state and the flow state live on the **topology**, not on a
request (#1427, #1429), two clients reading the same board read the same facts — and a
removal is visible in the same payload: delete the switch a flow crossed and the state
read shows the flow `reset`, with the reason, exactly as the delete's own answer did.

`test/state-payload-complete.test.js` pins it, 16 checks, against a real server.
### The reason a ping failed is the earliest cause, not the last

`ping` reports why nothing came back by reading the run's discard events **from the
end backwards**, so the reason it printed was the *last* discard — and the last one is
usually the least true. With the uplink shut and the ARP cache still warm:

```
replies: [{ success: false, reason: "peer port shut (r1 Gi0/0/0)" }]   <- correct: the wire is shut
```

but with a destination nobody owns (so the ARP request itself was dropped at the
shut port):

```
replies: [{ success: false, reason: "no ARP reply from 10.91.0.99" }]   <- the wire was shut, not silent
```

The end-of-run sweep that reports unanswered ARPs always lands *last* in the log,
so it always won — blaming silence for a frame that never left. And the reply only
searched the events *after* the ping started, so a shut port noticed earlier in the
run was invisible to it.

Now the whole run is searched, and the causes are **ranked**: a port or wire that
cannot carry the frame (`peer port shut`, `link administratively down`) first,
silence (`no ARP reply from X`) next, policy (`ACL … denied`, VLAN, NAT) last —
so a policy denial still outranks silence, and a shut port outranks both. The reply
also restores itself: `no shutdown` makes the same ping answer again, no stale
state.

`test/ping-reason-first-cause.test.js` pins all of it, 10 checks.
### One question, one answer: a lease is a fact about the lab

A DHCP lease used to be stored as a property of a *run*: `this._dhcpStates` was rebuilt
for every `Simulator`, and the server builds a fresh `Simulator` for every request. So the
client and its server were always in different requests. Measured against a live server,
with `r1 -- sw -- a/b` and both PCs on `ip address dhcp`:

```
request 1 (a pings)          -> a holds 10.91.0.10
request 2 (the board is read) -> a eth0 ip: 10.91.0.10     <- the client's half says yes
request 3 (r1 is asked)      -> "% no leases: nothing has asked this server for an address yet"
                                "In use: 0 of 41 address(es)"   <- the server's half says no
```

Two answers to one question, in one payload. And because every request started with an
empty allocator, the next client was handed the address the first already held — a conflict
the lab created and could not report. Inside one run the allocator also never honoured an
existing lease, so the clients traded addresses on every exchange (`.10 -> .12 -> .11`
across three runs) and no run could hold still.

So: lease state lives on the **topology** (`topo.dhcpStates`), exactly like the flow table.

- `show ip dhcp binding` in a later request sees the leases the earlier ones granted;
- `handleDiscover()` offers a client **the address it already holds** before the next free
  one, so a renewal keeps the address and two clients never trade;
- `/reset` clears the leases *and* the addresses they produced, together — clearing one
  without the other is the original contradiction. A typed address is configuration and
  stays; a DHCP-assigned one is runtime and goes;
- a deleted server device forgets its lease table (`Simulator.forgetDhcpState`), so a
  re-created id does not inherit the dead one's bindings;
- `leaseTable()` rows always carry their `pool`, and `show ip dhcp pool` counts a lease by
  membership in the pool, so `In use:` is a fact and not `0 of 41` while two leases stand —
  and never prints `undefined` for a pool that cannot serve yet.

`test/dhcp-lease-one-answer.test.js` pins all of it, 23 checks, against a real server.
### A conversation cannot outlive its path

The flow table belongs to the topology, and nothing told it when the topology changed. With
`r1 -- sw -- h1` and one established TCP conversation:

```
DELETE /links/l1      ->  200, and flow-1 is still `established` across a board with no cable
DELETE /devices/sw    ->  200, and flow-1 is still `established` on a two-device board with no links
create a new `sw`     ->  the brand-new switch reports packetsIn 5, packetsOut 5, ports {1: 6/5, 2: 5/6}
```

The first two are a board and a description of the board that disagree — a state no packet
could produce, which nothing would ever correct. The third is worse than stale: a new device
inheriting a dead device's tally, so "is this switch passing traffic?" answers yes for a box
created a second ago.

What makes this checkable is that a flow already knows the answer. Every established flow
records `rec.hops` — the devices its own handshake crossed, read out of the events the
timeline already shows a person, collapsed from the there-and-back trail to the path and
with both endpoints on it. So removal asks a fact rather than guessing:

- a hop that is gone → `reset`, reason naming the device;
- two consecutive hops that are no longer cabled → `reset`, reason naming the pair and the cable;
- a flow whose path is untouched → **left strictly alone**, state, bytes and tally, because a
  lab that healed should not lose its conversation.

`DELETE /devices/:id` and `DELETE /links/:id` both report what they ended
(`resetFlows: [{id, reason}]`), and a device that is deleted takes its counters with it
(`flow.forgetDevice`), which is why a re-created id starts uncounted. A flow that is already
reset is never swept twice: one failure, reported once.

`test/flows-follow-the-board.test.js` pins all of it, 21 checks — including the two that keep
the rule from being over-eager: an unrelated device removal ends nothing, and a reset flow is
not reported again.
### A door refuses all of a body, or applies all of it

`POST /api/topologies/:name/interfaces/:device/:port` writes four things — the
address, `enabled`, `description` and the cage's role. It used to write them as it
went, in that order, and answer `400` the moment one was refused:

```
{"ip":"10.9.9.9","mask":"255.255.255.0","role":"bogus"}   ->  400, and the address is stored
```

The caller is told the change failed while half of it happened. After that the board and
the sentence about the board disagree, and a person who reads "refused", reloads, and
finds a configured port has no way to know which of the two to believe. #1413 promised
this door "changes nothing on refusal"; that held only when the refused field happened to
come first.

Now every field is checked before any is written, and a refusal reports **every** problem
in one response (`{ code, error, problems: [{code, error}, ...] }`), so a client that sent
three bad fields learns about three. The address and its mask are one field: an address
that is not an address is refused before the mask is asked about.

Two doors in the same handler were asking the wrong question:

- `!!body.enabled` meant `{"enabled": "false"}` — a string JSON clients really do send —
  set the port **enabled** and answered `200`, the opposite of the request with an `ok`.
  It is a boolean or a refusal now, and the refusal quotes what it was given.
- `description` accepted any type; it is a string or a refusal.
- and a role refusal said `1 cannot be bogus`, which reads as a count. It says
  `port 1 cannot be bogus`.

`test/interface-door-atomicity.test.js` pins it: nine refused bodies, each compared
against a byte-identical snapshot of the port's configuration, plus five accepted bodies
that must actually change it — because a door that refuses everything would pass the first
half.
### A position is a place, not just a number

Two doors set a device's position: `POST /api/topologies/:name/layout` (the drag, and
the tidy-up button) and `Topology.fromJSON()` when a document is loaded. Both asked
for `{ x, y }` with two **finite** numbers, and the endpoint kept its own copy of that
sentence inline while the engine asked `isPosition()`.

`1e308` is finite and it is not a place. `fitView()` takes the board's width as the
largest x minus the smallest; for two such positions that is `Infinity`, zoom clamps to
its 0.25 floor, `translate()` is handed `-1e308`, and the canvas draws nothing — with
"Fit to view" computing the same arithmetic, so the board cannot be recovered from the
UI at all. The lab is not lost; it just cannot be seen, which for a person is the same
thing.

The rule now lives in one place, `engine/topology.js`:

- `WORLD_LIMIT = 1e6` — pixel positions within a million of the origin. Generous on
  purpose: a person drags across a canvas, and the biggest lab the catalogue can build
  spans tens of thousands. It exists so the framing arithmetic stays finite.
- `isPosition(p)` — two finite numbers inside that world; `positionProblem(p)` — why
  something is not, in words, so a refusal and the rule cannot disagree.
- Both doors ask it. A bad entry is refused with `E_BAD_POSITION` and the reason, and
  **nothing is stored**; on load the entry is dropped and reported as
  `E_LAYOUT_BAD_ENTRY` ("outside the canvas - x and y are pixel positions within
  1000000 of the origin"), so the board still opens.
- `positions` that is not a map is `400` rather than `200 {ok:true}` that changed
  nothing; an id that is not on the board comes back in `ignored`, because a client a
  moment behind a delete should not be lied to.
- `web/canvas.js` `fitView()` checks its own result: if the centre of what it measured
  does not land inside the viewport, the framing failed and the default view is the
  honest answer. That covers documents written before the limit existed.

`test/layout-positions.test.js` walks one table of shapes through both doors and
requires them to answer identically, then loads the real `web/canvas.js` in a stub DOM
and asserts the property the limit exists for: every position the doors accept is one
`fitView()` can frame.

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

### The same lab replays identically

Nothing in `engine/` reads a clock or rolls a die. Time is the simulator's own
`step`, identities are derived from names and ports, and a lease, a DNS cache
entry, an ARP entry or a NAT translation expires at a step count rather than a
timestamp. That is what makes a failure reproducible: the same document, driven
through the same sequence of commands, produces the same board - and therefore
the same payload - every time.

Three modules say so in a comment (`engine/flow.js`, `engine/nat.js`,
`engine/dhcp.js`) and `test/replay-identical.test.js` enforces it two ways:

- **statically** - no `Math.random(`, `Date.now(`, `new Date(`,
  `performance.now(`, `crypto.randomUUID(` or `process.hrtime` anywhere in
  `engine/*.js`, comments and strings excluded (the scanner is itself checked
  against a source that does contain one, so it cannot quietly stop working);
- **behaviourally** - the same lab built twice in one process, and again after a
  real wall-clock second, fingerprints the same (every `show` output plus
  `serialize()`); the same document driven through two independent servers with
  the same commands yields a **byte-identical** state payload; and reading one
  server's board a second later changes nothing, which is what would fail first
  if a clock-derived field were ever added to `fullState()`.

The fingerprint is also fed three *different* labs and required to tell them
apart - a different VLAN, a different address, one cable fewer - because a guard
that hashes nothing agrees with itself forever. And the payload being compared
has to be one traffic crossed: two empty boards are byte-identical too.

If a new mechanism genuinely needs wall-clock time, it belongs on the server
side of the socket (a request log, `Last-Modified`), not in engine state: a
payload that changes when nothing happened is a payload a client cannot use.

## The UI

`web/` is vanilla JavaScript + SVG with **no build step** — load it and it works.

- `canvas.js` — SVG rendering, pan/zoom, drag-to-move, port cabling, packet
  animation. Geometry is computed in a first pass so links can attach to ports.
- `app.js` — state, REST client, palette, inspector (device/config/console/
  simulate), context menus, keyboard shortcuts, WebSocket sync.

### An action that fails says so

`web/app.js` reports nearly every failure: `api()` records the failed call (so it
reaches a bug report) and rethrows, and the caller puts the reason in a toast, a hint
or the status bar. One did not:

```js
PFCanvas.on.move = async function (id, x, y) {
  topo.layout[id] = { x, y };
  try { await api('POST', '.../layout', ...) } catch (e) {}   // the drag was a save, and the save was lost
};
```

Drag a device while the position is refused (or the server is not there) and the box
stays where it was dropped: the canvas shows a lab that is not the lab on disk, and the
next reload - or another tab's next broadcast - moves it back with no explanation.

Now: the position is put back and the reason is shown. And the rule is pinned -
`test/ui-action-failures.test.js` scans `web/*.js` and requires every `catch` whose try
block calls `api()` to reach the user (`toast`, `setStatus`, `setLinkHint`,
`recordError`, writing into the page, or a rethrow), **or** to carry
`/* silent-ok: <reason> */`, which is a sentence a reviewer has to read. `console.error`
alone does not count: the person who clicked does not read the console, which was the
finding of #20.

The same sweep fixed one more silence: the palette's "someone asked for this" markers
were **emptied** when the forge was slow (`openRequests = []`), which is not "unchanged";
they are kept now.

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
