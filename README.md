# PacketForge

**An open-source, vendor-agnostic network simulator — a modern alternative to
Cisco Packet Tracer.**

[![CI](https://git.jayw.uk/jaylouisw/packetforge/badges/workflows/ci.yml/badge.svg)](https://git.jayw.uk/jaylouisw/packetforge/actions?workflow=ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

PacketForge lets you drag-and-drop routers, switches, hosts, firewalls, access
points and point-to-point radios onto a canvas, cable them together, configure
them from a CLI, and watch real packets (ARP, IPv4, ICMP) flow through the
topology — hop by hop — in your browser. It is **not** tied to any one vendor:
a Cisco, Juniper, Arista, MikroTik, Huawei or Ubiquiti box is just a JSON file,
and they all run the same simulation engine and the same command set.

- **Zero runtime dependencies.** `node server/index.js` and you're done. No
  `npm install`, no database.
- **Real simulation, not canned animation.** The engine does MAC learning,
  flooding, ARP resolution, longest-prefix routing, default gateways, TTL
  decrement and ICMP echo/reply — with a replayable event stream.
- **Modern web UI.** Dark theme, pan/zoom canvas, drag-to-move, click-a-port-to-cable, right-click-a-cable-to-pull-it,
  per-device console, live packet animation, WebSocket multi-client sync.
- **Physically accurate.** 89 media types across nine families (Ethernet, Fibre Channel,
  GPON, DOCSIS, DSL, powerline, DAC, console, wireless) and 26 connector cages; per-port speed
  capabilities and PoE budgets. Impossible cables are
  *refused*, not drawn — an SC/APC patch lead will not go into an SC/UPC socket.
  See [docs/PHYSICAL_LAYER.md](docs/PHYSICAL_LAYER.md) and
  [docs/CONNECTORS.md](docs/CONNECTORS.md).
- **Any hardware.** Add a new model in ~10 lines of JSON. See
  [docs/DEVICE_REGISTRY.md](docs/DEVICE_REGISTRY.md).

---

## Quick start

### From source

```bash
git clone https://git.jayw.uk/jaylouisw/packetforge.git
cd packetforge
node server/index.js
```

Open **http://localhost:8000**.

### With Docker

There is **no published image**: nothing in this repository pushes one, and an anonymous
`docker pull ghcr.io/jaylouisw/packetforge` is denied. Build it yourself — the Dockerfile is one
stage on `node:20-alpine`, runs as the unprivileged `node` user, and carries a `HEALTHCHECK` that
polls `/api/catalog`:

```bash
docker build -t packetforge .
docker run --rm -p 8000:8000 packetforge
```

Then open **http://localhost:8000**. Verified from a clean checkout: the build succeeds, the
container answers `GET /api/version` on Node 20, and the whole catalogue (1,626 models) is inside.

### If it will not start

The server translates the failures it can recognise into a message you can act on, and prints a
pre-filled bug-report link for the ones worth reporting (`server/startup-error.js`). A busy port is
the common one:

```
  Port 8000 is already in use, so PacketForge could not start.
  Something else is already listening on port 8000. The usual cause is a
  PacketForge that is still running in another terminal or in the background.

  Stop that copy, or start this one on a different port:

      PORT=8081 npm start          (macOS, Linux, git-bash)
      $env:PORT=8081; npm start    (PowerShell)
      set PORT=8081 && npm start   (cmd.exe)

  Nothing has been lost: topologies are saved as they change.
```

`EACCES` (a port below 1024 as a normal user) and `EADDRNOTAVAIL` get their own short explanations,
neither marked reportable — they are configuration, not bugs. Anything else is printed as
`PacketForge failed to start: <the error>` with the advice to paste the whole terminal output.

**`PORT` is read with `parseInt`, so it is not validated — and two mistakes are silent or ugly:**

| `PORT=` | What happens |
|---|---|
| `8081` | starts on 8081, as expected |
| `8000 ` or ` 8000` | whitespace is tolerated, `parseInt` ignores it |
| `1.2.3.4` | becomes **`1`** — the server starts on port 1 and the banner says `http://localhost:1`. It does not complain, so set a number, not an address |
| `abc` | `parseInt` gives `NaN` and `server.listen` throws **before** the error handler exists: you get a raw `RangeError [ERR_SOCKET_BAD_PORT]` stack trace, not the friendly message |

So the `EADDRNOTAVAIL` advice above ("set PORT to a port number only") cannot be reached by typing an
address into `PORT` — the value is already truncated by the time it is used. If you see a stack trace
mentioning `ERR_SOCKET_BAD_PORT`, `PORT` is the thing to look at.

### First lab

1. Click a device in the left palette (e.g. *Router*), then click the canvas to place it.
2. Place two *PC*s and a *Switch*.
3. Cable them, either way:
   - **Device first (recommended):** click 🔗 **Create link** (or press `C`), click the switch,
     then the PC. The panel lists the link types the two boxes can actually share — 1000BASE-T,
     10GBASE-LR — with the port pairs underneath, and `Esc` cancels. If nothing fits it says why
     (`E_CONNECTOR_MISMATCH`, `E_NO_FREE_PORTS`, …) instead of failing one guess at a time.
   - **Port first:** click a port on one device, then a port on another.
4. Select a PC → **Console** tab → type:

   ```
   configure terminal
   interface eth0
   ip address 192.168.1.10 255.255.255.0
   ```

5. Select the other PC, give it `192.168.1.20/24`.
6. Select the first PC → **Simulate** tab → ping `192.168.1.20`.

You'll see ARP requests flood the switch, the reply come back, and the ICMP
echo/reply travel across the link with a live animation and event log.

---

## Example labs

Four labs ship as JSON, and each one is checked by a ping when it is built:

| File | In it | What it is for |
|---|---|---|
| `lab1-two-pcs-switch.json` | 2 PCs, 1 switch (3 devices, 2 cables) | the smallest thing that works — `192.168.1.10` ↔ `192.168.1.20` through a switch, so you can see MAC learning and flooding without configuring anything |
| `lab2-router-two-subnets.json` | 2 PCs, 1 router (2 subnets: `10.0.1.0/24`, `10.0.2.0/24`) | routed traffic: `10.0.1.10` reaches `10.0.2.20` via `Gi0/0`/`Gi0/1`, and route lookup, ARP and the TTL are all visible in the timeline |
| `lab3-multi-vendor-campus.json` | 8 devices from 4 vendors — cloud, Cisco `ISR4321`, MikroTik `CRS326-24G`, Huawei `S5735-L24T4S`, Ubiquiti `EdgeSwitch-16`, 2 PCs, 1 server (7 cables) | a campus edge with a WAN: a static default route on `EDGE` toward `198.51.100.1`, and `10.0.0.0/24` behind it |
| `lab4-vlans-trunk-stp.json` | 2 switches, 3 PCs (5 cables, including a second link between the switches) | VLANs 10 and 20 over a trunk with a deliberate loop, so STP has to block one port before anything passes |

**`lab4` is the one lab where something does not ping, and it is worth knowing which.** The loop is
broken by spanning tree before any traffic passes: SW2 blocks `Fa0/8` as an alternate, and says why —
`Fa0/8 is alternate: SW1 reaches the root for 0, this bridge for 20000` — while `Fa0/7` becomes its root
port. What that leaves, measured on the file as shipped:

| From → to | Result |
|---|---|
| `PC1` 192.168.10.10 → `PC2` 192.168.10.20 | **4/4**, over `SW1 Fa0/7 → SW2 Fa0/7` (the port STP kept) |
| `PC1` → `PC3` 192.168.10.30 | **0/4** |
| `PC2` → `PC3` | **0/4** |

`PC3` is not broken by STP: it is on `SW2 Fa0/2`, which is in **VLAN 20**, while its address is in the
VLAN 10 subnet. There is no router and no SVI in the lab, so VLAN 20 has nowhere to go — `show vlan brief`
on SW2 lists `20 GUEST active Fa0/2, Fa0/7(t), Fa0/8(t)` and nothing bridges the two VLANs. Move that
port into VLAN 10 and all three PCs are in one broadcast domain — measured, from the console, with STP
still blocking `Fa0/8` afterwards:

```text
SW2(config)#interface Fa0/2
SW2(config-if)#switchport mode access
Switchport mode access on Fa0/2
SW2(config-if)#switchport access vlan 10
Access VLAN 10 on Fa0/2
```

`PC1 → PC3` and `PC2 → PC3` then report `Success rate is 100 percent (4/4)`. Leave the port where it is
and the lab is a working example of a device that is cabled, up, and unreachable.

Open one with the **Import** button in the editor — it posts the file to
`POST /api/topologies/<id>/load` — or from the shell:

```bash
curl -X POST http://localhost:8000/api/topologies/default/load \
  -H 'content-type: application/json' --data-binary @examples/lab4-vlans-trunk-stp.json
```

The file *is* the topology document (`{format, version, seq, devices, links, layout}`), so it needs no
unwrapping. **Loading replaces the board wholesale and writes it to disk immediately** — there is no
merge and no undo, and `default` is the board you land on, so importing a lab into a running server
overwrites whatever was there. Import into a fresh board (`POST /api/topologies {"id":"lab4"}` first)
if you want to keep what you had.

**These files are generated — edit `examples/build-examples.js`, not the JSON.** The script builds each
lab through the engine, writes it, then reloads it and pings a host to prove it works
(`wrote lab4-vlans-trunk-stp.json (5 devices, 5 links)` … `verify lab4-vlans-trunk-stp.json: ping OK`).
Running it on a clean tree reproduces the four committed files byte for byte. Devices that the
generator does not name keep their automatic names, which is why `lab3` shows `CRS326-24G-2S+IN-d3`
rather than `SW1`.

## Features

| Area | What's implemented |
|------|--------------------|
| Devices | router, L2 switch, L3 switch, PC, server, firewall, access point, PTP radio, cloud |
| Vendors | **1,626 models across 246 vendors**, in **25** `category` values rendered as **24** palette buckets (router, switch, L3 switch, firewall, wireless AP, PTP radio, OLT, ONT, modem, powerline, NAS, server, desktop, laptop, tablet, phone, printer, camera, NVR, IoT, tap, splitter, cloud, host), plus the generic models. The 25th category is `ap`, and it has exactly one member — `huawei/WiFi Extender AX3000`. It has no bucket in `CAT_ORDER` and no entry in `BADGE_LABELS`, so it is **not offered in the type filter** and its card shows the raw string `ap` where every other device shows a label; it is still findable by search, and it renders with the wireless icon. Adding a model is a single JSON file ([registry](docs/DEVICE_REGISTRY.md)) |
| L2 | MAC address table, learning, unknown-unicast/broadcast flooding |
| L3 | IPv4 addressing, connected + static routes, default gateway, longest-prefix match |
| Protocols | ARP, IPv4, ICMP echo/reply, **DHCP client + server** (pools, ranges, exclusions, reservations — in the data path), DNS (NXDOMAIN/NODATA/SERVFAIL), NAT (static, dynamic pool and PAT — all three translated in the data path, configured in the topology JSON; there is **no `nat` config command**, but [`show ip nat translations` / `statistics`](docs/CLI.md#nat--configured-in-the-topology-not-the-cli) read back what the data path wrote), extended ACLs, OSPF, BGP, SCION, **VRRP** (election, virtual MAC, gratuitous ARP on takeover), IPv6 with SLAAC/RA, LLDP, 802.1D STP, 802.1Q VLANs, LACP |
| Transport flows | A conversation, not a probe: the three-way handshake as three real frames, an MSS derived from the path MTU, cumulative ACKs, four-way close, per-flow state (`engine/flow.js`). Every segment is a frame an ACL can deny, NAT can rewrite or an under-budget PSE can refuse |
| Physical layer | 89 media types, 26 connector cages, per-port speed caps + PoE, live feasibility validation, Fibre Channel as its own protocol ([docs](docs/FIBRE-CHANNEL.md)) |
| L2 features | 802.1Q VLANs (access/trunk/native), LAG aggregation (`active`/`passive`/`on`/`static` from the CLI, translated to the validator's vocabulary — see [CLI.md](docs/CLI.md#link-aggregation)), 802.1D spanning tree, **port security** (source limits, sticky learning, `protect`/`restrict`/`shutdown` violations, aging, `clear port-security`), LLDP both directions, static ARP entries a lab cannot relearn |
| CLI | Cisco-like vendor-agnostic console: `show` (incl. `ip ospf` / `ip ospf neighbor`, `dns`, `scion`, `ip bgp`, `vrrp`, `lldp neighbors`, `access-lists`, `spanning-tree`, `ipv6 nd`), `interface`, `ip address`, `ip dhcp pool`, `ip route`, `ipv6 route` / `ipv6 address`, `access-list`, `vlan`, `switchport`, `channel-group`, `vrrp`, `ospf`, `router bgp`, `dns zone`, `scion`, `ping [count] [at <ms>]`, `traceroute`, `nslookup`, `converge`, `link up\|down\|state`, `ip routing`, `mtu`/`speed`/`duplex`, `power inline`, `lldp run` and per-port `lldp transmit`/`receive`, `arp <ip> <mac>`, `ip domain-lookup`/`ip domain-name`, `interface vlan` (an SVI — `Vlan10` shows `up/down` in the brief while no port carries that VLAN, and installs no connected route until one does), the `clear` family, `help`/`?` in any position, and **IOS-style abbreviation** (`sh ip int br`) resolved against the live grammar rather than a word list ([full reference](docs/CLI.md)) |
| UI | drag-drop canvas, pan/zoom, port cabling, per-device console, packet animation, event log |
| Convergence | Control planes take time: STP Listening/Learning, OSPF hello + SPF hold, DHCP exchange, VRRP master-down. Ask any question at an instant with `setRunTime(ms)` / `ping ... at 5000`; an unfinished process reports `converging`, not "timed out" ([docs](docs/CONVERGENCE.md)) |
| Link failure | Pull a cable without deleting it: frames die at the link, STP heals around it, MAC tables flush, and every timer re-runs from the instant of the change. `link down l5 at 10000` then ask at 11000 — nothing gets through, and the reply says so ([docs](docs/LINK-STATE.md)) |
| Latency | Per-link propagation from the medium's velocity, serialisation from frame size and line rate, store-and-forward per hop — so a 40 km span is not the same as a 1 m patch lead |
| Persistence | save/load topologies as JSON — import/export buttons in the browser, and the server writes one file per board to `data/topologies/` (atomic rename, no database), so restarting the server does not lose the lab |
| Sync | WebSocket broadcasts topology edits to every connected client in real time |

### What this does not model yet

Stated plainly, because a simulator that overstates itself teaches wrong things:

- **DHCP relay.** A DISCOVER does not cross a router, so a central server cannot serve a remote
  subnet. Snooping, Option 82 and DHCPv6 are absent too; leases are computed at run start and do not
  age.
- **HSRP and GLBP.** VRRP is wired (election, virtual MAC, failover); the Cisco and Avaya
  equivalents are not modelled, and neither is BFD or graceful restart.
- **Timed interleaving.** Control planes have a duration, and pulling a cable re-bases the schedule
  from that instant ([CONVERGENCE.md](docs/CONVERGENCE.md), [LINK-STATE.md](docs/LINK-STATE.md)) — but
  a question is answered *as of* an instant: no hello is ever lost, no dead-interval expires on its
  own, and nothing converges unless something asks. A lab that fails silently does not fade out; the
  next `ping` simply finds the new answer.
- **Application protocols.** A transport flow is modelled properly — three-way handshake as three
  packets, MSS from the path MTU, cumulative ACKs, four-way close — but nothing above it: no HTTP
  request, no TLS handshake, no SSH banner. Flows only exist when the API opens one (`POST /flows`);
  no packet starts a connection on its own ([docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#transport-flows)).
- **ICMP beyond echo.** Echo request/reply only — no destination-unreachable, no time-exceeded, no
  redirect. A black-holed packet and a TTL expiry therefore both look like silence to `ping`. The
  `traceroute` command exists, but it walks the routing tables to print the path rather than
  sending TTL-limited probes, so it would gain nothing from a time-exceeded message
  ([SIMULATION.md §3.2](docs/SIMULATION.md)).

Each of these is a tracked issue rather than a surprise.

---

## Documentation

All eighteen documents in [docs/](docs/), in the order you are likely to want them.

**Start here**

- [ARCHITECTURE.md](docs/ARCHITECTURE.md) — how the engine is put together: modules, the packet
  path, the server, and where a new feature belongs.
- [SIMULATION.md](docs/SIMULATION.md) — what is modelled, what is not, and why; the honest inventory
  this README's feature table is drawn from.
- [CLI.md](docs/CLI.md) — the full command reference, mode by mode.

**The physical layer**

- [PHYSICAL_LAYER.md](docs/PHYSICAL_LAYER.md) — media, cages, speed caps, PoE budgets, the
  feasibility rules, and every `E_*`/`W_*` code the engine can emit.
- [CONNECTORS.md](docs/CONNECTORS.md) — connector families, ferrule polish, and why a particular
  cord is refused.
- [HYBRID-PATCH.md](docs/HYBRID-PATCH.md) — UPC↔APC hybrid cords: the reflection the mating costs
  you and the real part numbers that do it.
- [FIBRE-CHANNEL.md](docs/FIBRE-CHANNEL.md) — Fibre Channel as its own protocol with its own
  link-type rules.

**Devices and behaviour**

- [DEVICE_REGISTRY.md](docs/DEVICE_REGISTRY.md) — the device JSON schema, every key, and how to add
  a model.
- [CONVERGENCE.md](docs/CONVERGENCE.md) — how long each control plane takes, and how to ask a
  question at a chosen instant.
- [LINK-STATE.md](docs/LINK-STATE.md) — pulling a cable without deleting it, and what re-converges.
- [BGP-POLICY.md](docs/BGP-POLICY.md) — path-attribute policy: the decision-order subset that
  exists today, and the full design it is aiming at.

**Operating and contributing**

- [CI.md](docs/CI.md) — every job, what it actually asserts, and the known gaps.
- [MIRRORING.md](docs/MIRRORING.md) — Forgejo is home, GitHub is a mirror; what syncs and what
  cannot.
- [PUBLIC-ACCESS.md](docs/PUBLIC-ACCESS.md) — Cloudflare Zero Trust in front of the instance.
- [REQUESTING-HARDWARE.md](docs/REQUESTING-HARDWARE.md) — how to ask for a device, and what a good
  request contains.
- [TRIAGE.md](docs/TRIAGE.md) — the maintainer's side of that queue.
- [ROADMAP.md](docs/ROADMAP.md) — what is done and what is next, by area, with the gap named
  honestly in each.
- [UPSTREAM-DESIGN.md](docs/UPSTREAM-DESIGN.md) — upstream, transit and multihoming: a design
  proposal with its migration table, not a description of shipped code.

---

## Architecture

```
packetforge/
├── engine/          # pure-JS simulation engine (zero deps)
│   ├── net.js       #   IPv4 / MAC / subnet helpers
│   ├── device.js    #   Device + Interface model
│   ├── link.js      #   Link model
│   ├── topology.js  #   Topology container + (de)serialization
│   ├── simulator.js #   event-driven L2/L3/ARP/ICMP engine
│   ├── cli.js       #   vendor-agnostic management console
│   └── index.js     #   public API
├── devices/         # hardware catalog — JSON only
│   ├── registry.js  #   loads + groups device specs
│   └── <vendor>/*.json
├── catalogue/       # the other catalogue: real optics, not abstract media
│   └── optics/      #   transceivers.json (58 part numbers), odn.json (16 splitters/cords),
│                    #   hybrid-patch-cords.json (13 UPC↔APC assemblies) — read by engine/optical.js
├── research/        # datasheet research intake; findings land here before they are applied
│   └── incoming/    #   the JSON that scripts/apply-research.js and import-devices.js consume
├── server/          # HTTP + hand-rolled WebSocket server (zero deps)
├── web/             # frontend (vanilla JS + SVG, no build step)
├── examples/        # ready-to-import lab topologies
├── test/            # engine + CLI tests
├── scripts/         # the guards (syntax, control bytes, Node floor, canonical URLs) and the
│                    # research/import/audit tools — 25 of them
├── .github/         # issue/PR templates, labels, dependabot (no workflows — see docs/CI.md)
├── .forgejo/        # the real CI: ci.yml + auto-rebase.yml
└── docs/            # eighteen documents — indexed under "Documentation" above
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design.

---

## Tests

```bash
npm test                          # the whole suite (see docs/CI.md — it is three commands)
node examples/build-examples.js   # regenerates + self-verifies the example labs
npm run syntax                    # syntax-check every JS file
```

---

## Why not just use Packet Tracer / GNS3 / EVE-NG?

- **Packet Tracer** is Windows/macOS-only, closed-source, Cisco-centric, and its
  "simulation" is partly scripted rather than a real protocol engine.
- **GNS3 / EVE-NG** run *real* firmware images — powerful but heavy (need images,
  licenses, virtualization), and overkill for learning fundamentals.
- **PacketForge** is browser-native, instant, open source, and models *behavior*
  generically so the same engine works for every manufacturer. It's designed to
  be forked and extended.

---

## Contributing

Contributions are welcome — especially new hardware models. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the full guide and
[docs/DEVICE_REGISTRY.md](docs/DEVICE_REGISTRY.md) for the device schema.

## Where this project lives

Development, CI and releases run on **Forgejo**; GitHub is a read-only mirror. Where the two differ,
Forgejo is right. [docs/MIRRORING.md](docs/MIRRORING.md) explains what stays in sync, what cannot,
and how a contribution made on GitHub reaches review here.

### Want a device added?

[**Open a hardware request →**](https://git.jayw.uk/jaylouisw/packetforge/issues/new?template=device_request.yml)

Every device is one JSON file, so a good request is mostly a good datasheet link.
Anything internet-connected is in scope: routers, switches, firewalls, APs and
point-to-point radios, OLTs and ONTs, cable and DSL modems, powerline and MoCA
adapters, servers, NAS, laptops, phones, printers, IP cameras, NVRs and IoT gear.

Requests are triaged with `node scripts/request-queue.js`, which checks each one
against the catalog and for a usable datasheet before any time is spent on it.
The full process — what we need, what happens, and what we will not do (invent
port counts) — is in [docs/REQUESTING-HARDWARE.md](docs/REQUESTING-HARDWARE.md).

Please report security issues privately — see [SECURITY.md](SECURITY.md).

## License

MIT — see [LICENSE](LICENSE). Roadmap in [docs/ROADMAP.md](docs/ROADMAP.md).
