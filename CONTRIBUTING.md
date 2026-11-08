# Contributing to PacketForge

Thanks for helping out. PacketForge is built to be easy to extend — adding a piece
of hardware is a single JSON file with **no code changes**. This guide covers the
common paths.

## Ways to contribute

- **Add a hardware model** — the most common contribution (see below).
- **Fix a bug** in the engine, CLI, server, or web UI.
- **Improve documentation**.
- **Report a bug or request a device** via an issue.

## Ground rules

- Behave per the [Code of Conduct](CODE_OF_CONDUCT.md).
- One logical change per pull request.
- Keep the project **zero-dependency** — do not add npm packages without a strong
  reason and a discussion in the issue first.
- All checks must pass before merge (CI runs them automatically).

## Development setup

There is no install step and no build step:

```bash
git clone https://github.com/Jaylouisw/packetforge.git
cd packetforge
node server/index.js        # UI + JSON API on http://localhost:8000
```

Run the checks locally before submitting. GitHub CI and the local pipeline run the
*same* commands, so what passes on your machine passes in CI:

```bash
npm run check      # fast gates: syntax + control bytes + catalogue audit
npm test           # every test/*.test.js, all failures reported
npm run ci         # everything GitHub CI runs: gates + tests + example labs
```

The individual suites still work (`npm run test:engine`, `npm run test:cli`, ...),
and `npm test -- --filter vlan` runs only the suites whose name matches `vlan`.

Install the pre-commit gate once, so fast checks run on every commit:

```bash
npm run hooks      # or: make hooks
```

`make check` / `make ci` / `make lint-workflows` mirror the same targets for
contributors who reach for Make first.

## Adding a hardware model

The catalog is pure JSON. Adding a model = adding one file:

1. Create `devices/<vendor>/<model>.json`.
2. Fill in the fields (schema in [docs/DEVICE_REGISTRY.md](docs/DEVICE_REGISTRY.md)).
3. Run `npm test` and `npm run syntax`.
4. Open a pull request.

Minimal example:

```json
{
  "vendor": "acme",
  "model": "AC-R9000",
  "label": "ACME Router 9000",
  "category": "router",
  "description": "Fictional 8-port gigabit router.",
  "capabilities": ["l3-forward", "cli", "nat", "dhcp-server"],
  "interfaces": [
    { "name": "eth0", "type": "ethernet", "speed": "1G" },
    { "name": "eth1", "type": "ethernet", "speed": "1G" }
  ],
  "icon": "router",
  "color": "#ff6600"
}
```

### Datasheet accuracy is mandatory

Port counts, speeds, and capabilities must match the manufacturer's datasheet.
Enumerate the **full** physical port complement — a "24-port switch" is almost
always 24×RJ45 **plus** 2–4×SFP(+). The headline number hides the uplinks. Never
model a representative subset; the project verifies specs against the datasheet.

### Categories and capabilities

- `category` is one of: `router, switch, l3-switch, firewall, ont, host, server,
  wireless, ptp, cloud`.
- `capabilities` are one or more of: `host, l2-forward, l3-forward, cli,
  dhcp-server, dhcp-client, nat, firewall, wireless, http-server`.

Adding a **new** category is a three-file change (`devices/registry.js`,
`web/app.js`, `web/canvas.js`) — call it out in the PR rather than doing it silently.

## Code style

- CommonJS modules, `'use strict';` at the top.
- 2-space indentation, single quotes, semicolons.
- Prefer plain functions and `Map`/`Set` over clever one-liners — the engine is
  meant to be read by students.

## Commit messages

Use a plain imperative subject line, e.g.:

- `Add airFiber 5XHD radio`
- `Fix CRS326-24G port count`
- `Add PTP radio category`

No trailing period, no scope prefixes.

## Review process

1. A maintainer reviews the PR.
2. CI must be green (tests, syntax check, example-lab build).
3. For device additions, the maintainer cross-checks the datasheet.

Thank you for contributing!
