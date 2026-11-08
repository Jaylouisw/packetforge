# PacketForge

**An open-source, vendor-agnostic network simulator — a modern alternative to
Cisco Packet Tracer.**

[![CI](https://github.com/Jaylouisw/packetforge/actions/workflows/ci.yml/badge.svg)](https://github.com/Jaylouisw/packetforge/actions/workflows/ci.yml)
[![CodeQL](https://github.com/Jaylouisw/packetforge/actions/workflows/codeql.yml/badge.svg)](https://github.com/Jaylouisw/packetforge/actions/workflows/codeql.yml)
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
- **Modern web UI.** Dark theme, pan/zoom canvas, drag-to-move, click-a-port-to-cable,
  per-device console, live packet animation, WebSocket multi-client sync.
- **Physically accurate.** 64 media types across eight families and 19 connector
  cages; per-port speed capabilities and PoE budgets. Impossible cables are
  *refused*, not drawn — an SC/APC patch lead will not go into an SC/UPC socket.
  See [docs/PHYSICAL_LAYER.md](docs/PHYSICAL_LAYER.md) and
  [docs/CONNECTORS.md](docs/CONNECTORS.md).
- **Any hardware.** Add a new model in ~10 lines of JSON. See
  [docs/DEVICE_REGISTRY.md](docs/DEVICE_REGISTRY.md).

---

## Quick start

### From source

```bash
git clone https://github.com/Jaylouisw/packetforge.git
cd packetforge
node server/index.js
```

Open **http://localhost:8000**.

### With Docker

```bash
docker run --rm -p 8000:8000 ghcr.io/jaylouisw/packetforge:latest
```

Then open **http://localhost:8000**.

### First lab

1. Click a device in the left palette (e.g. *Router*), then click the canvas to place it.
2. Place two *PC*s and a *Switch*.
3. Click a port on one device, then a port on another, to cable them.
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

## Features

| Area | What's implemented |
|------|--------------------|
| Devices | router, L2 switch, L3 switch, PC, server, firewall, access point, PTP radio, cloud |
| Vendors | Cisco, Juniper, Arista, MikroTik, Huawei, Ubiquiti, TP-Link, Netgear, Zyxel, GL.iNet, Protectli, QNAP, Qotom, TRENDnet, Adtran, Raspberry Pi + generic models (**91 models / 17 vendors**) |
| L2 | MAC address table, learning, unknown-unicast/broadcast flooding |
| L3 | IPv4 addressing, connected + static routes, default gateway, longest-prefix match |
| Protocols | ARP (request/reply, cache), ICMP echo request/reply, TTL handling |
| Physical layer | 64 media types, 19 connector cages, per-port speed caps + PoE, live feasibility validation |
| L2 features | 802.1Q VLANs (access/trunk/native), LACP aggregation, 802.1D spanning tree |
| CLI | Cisco-like vendor-agnostic console: `show`, `interface`, `ip address`, `ip route`, `ping` |
| UI | drag-drop canvas, pan/zoom, port cabling, per-device console, packet animation, event log |
| Persistence | save/load topologies as JSON (import/export buttons) |
| Sync | WebSocket broadcasts topology edits to every connected client in real time |

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
├── server/          # HTTP + hand-rolled WebSocket server (zero deps)
├── web/             # frontend (vanilla JS + SVG, no build step)
├── examples/        # ready-to-import lab topologies
├── test/            # engine + CLI tests
├── scripts/         # syntax checker + merge tools
├── .github/         # CI/CD workflows, issue/PR templates
└── docs/            # architecture, registry, CLI, roadmap
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design.

---

## Tests

```bash
npm test                          # engine + CLI tests
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

### Want a device added?

[**Open a hardware request →**](https://github.com/Jaylouisw/packetforge/issues/new?template=device_request.yml)

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
