# Getting started

PacketForge has **no runtime dependencies**. Node 18 or newer and a browser is the whole
list - no npm install, no Docker, no database.

```bash
git clone https://git.jayw.uk/jaylouisw/packetforge.git
cd packetforge
node server/index.js          # http://localhost:8000
```

Nothing to install: the server serves the UI from `web/` and keeps topologies as JSON files.

## Your first lab

1. Drag two hosts and a switch out of the palette onto the canvas.
2. Click a port, then click the port on the other device. The cable is checked before it is
   made - if the two cages cannot meet, you get the reason instead of a broken link.
3. Open a host's config and give it an address; give the other host an address in the same
   subnet.
4. Use **ping** from one host to the other.

If ping works, ARP resolved, the switch learned, and the frames went both ways - the packet
animation shows the path.

## Things worth trying early

- **A cable that should be impossible.** Mate an SC/UPC PON port to an SC/APC one. It
  refuses, and names the hybrid patch cord that resolves it, by part number.
- **A slower optic than the port allows.** Put a 1G SFP in a 10G SFP+ cage: the link comes
  up at 1G, because that is what would happen.
- **`npm run smoke`** - drives the HTTP API end to end, the way the UI does.

## Where things live

| Path | What it is |
| --- | --- |
| `devices/` | the catalogue: one JSON file per model |
| `engine/` | the simulator: physical layer, L2/L3, routing, protocols |
| `web/` | the canvas UI, plain JavaScript, no build step |
| `docs/` | architecture, CLI, registry format, and the honest capability matrix |
| `examples/` | runnable labs |
