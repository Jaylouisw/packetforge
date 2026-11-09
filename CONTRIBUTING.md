# Contributing to PacketForge

Thanks for helping out. PacketForge is built to be easy to extend — adding a piece
of hardware is a single JSON file with **no code changes**. This guide covers the
common paths.

## Two doors, and which one is yours

The project is developed on its own forge at <https://git.jayw.uk/jaylouisw/packetforge>, which is
public to read. Accounts there are not open to the public — the maintainer is the only account — so
**contributors work through the GitHub mirror at <https://github.com/Jaylouisw/packetforge>**.

| You want to | Do it on |
|---|---|
| Read the code, browse history, download a release | Either — both carry the same commits |
| Open an issue or a device request | GitHub |
| Send a fix or a new device | Fork and open a pull request on GitHub |
| Review, run CI, merge | The forge (maintainer only) |

Pull requests opened on GitHub are carried across to the forge automatically by
`scripts/gh-bridge.js`: the contributor's commits are pushed as a `gh/<number>` branch, verbatim and
with authorship intact, and a pull request is opened there so CI and review happen in one place. A
maintainer replies on your GitHub thread. You never need an account on the forge, and the forge never
needs one of your keys.

The direction of travel is **forge → GitHub for code, GitHub → forge for contributions**. The mirror
pushes automatically on every commit; the bridge pulls contributions in. Neither side is a fork of
the other in spirit: the forge is the workshop, GitHub is the shopfront.

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
- All checks must pass before merge (CI runs them automatically — what each one
  does, and what a red one means, is in [docs/CI.md](docs/CI.md)
- [docs/MAINTAINING.md](docs/MAINTAINING.md) - how a vendor gets from request to reviewed spec, and which source to trust).
- [docs/DEVICE_SCHEMA.md](docs/DEVICE_SCHEMA.md) - every field a spec may use, and what the importer refuses
- [docs/BUG_REPORTS.md](docs/BUG_REPORTS.md) - what the app fills in for you, and the two things only you can write

## Development setup

There is no install step and no build step:

```bash
git clone https://git.jayw.uk/jaylouisw/packetforge.git
cd packetforge
node server/index.js        # UI + JSON API on http://localhost:8000
```

Run the checks locally before submitting:

```bash
npm run syntax                    # syntax-check every JS file
npm run test:engine               # engine tests
npm run test:cli                  # CLI tests
npm run examples                  # rebuild + verify the example labs
# or simply:
npm test
```

## Adding a hardware model

The catalog is pure JSON. Adding a model = adding one file:

1. Create `devices/<vendor>/<model>.json`.
2. Fill in the fields (schema in [docs/DEVICE_REGISTRY.md](docs/DEVICE_REGISTRY.md)).
3. Run `npm test` and `npm run syntax`.
4. Open a pull request.

Before adding a model, it is worth asking whether it is already here under a different spelling —
`node scripts/sweep-device-requests.js --limit 700` answers that against the live request queue,
and [docs/DEVICE_REQUEST_SWEEP.md](docs/DEVICE_REQUEST_SWEEP.md) explains what its guards do and
why each one exists.

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
2. CI must be green (tests, syntax check, example-lab build). [docs/CI.md](docs/CI.md)
   lists the five checks and how to run each of them locally.
3. For device additions, the maintainer cross-checks the datasheet.

Thank you for contributing!

## Exemptions have to be claimed

An invariant is only as strong as the classes of hardware it actually checks. Three separate bugs
in this repository came from the same sentence — a `continue` that quietly removed a group of ports
from a check because they were "special":

```js
if (isConsoleOnly(i.hardware)) continue;   // 163 console ports, each claiming a gigabit (#979)
if (!i.hardware.media.length) continue;    //  84 coax ports that could not be cabled at all (#1039)
const top = Math.max.apply(null, caps);    //  NaN for caps written "10G", so nothing was compared (#993)
```

Each was defensible on the day it was written, each had a comment explaining why, and none of them
appeared in the backlog. `test/skip-audit.test.js` now reads the test sources and requires every
skip that decides *a piece of hardware is outside a check* — by its type, its prose, its class or
its media — to carry one of:

```js
// #1234 - the issue that tracks this exemption, if it is a gap
if (isConsoleOnly(hw)) continue;

// not an exemption: this loop is looking for something that is not there
if (!spec) continue;

// A deliberate exemption: a device describing both PoE-in and PoE-out is a passthrough.
if (POE_IN.test(desc) && POE_OUT.test(desc)) continue;
```

The audit does not judge whether an exemption is *correct* — only that it is claimed, tracked and
findable. If you are adding a rule and a class of devices fails it, that is a decision about the
catalogue: either fix the devices, or open an issue and reference it.

## The Node 18 floor is real

CI runs the suite on Node 18, 20 and 22. If you develop on something newer, `npm test` can be green
locally and the Node 18 job can fail twenty minutes later, which reads like a flaky runner rather
than "you used a Node 20 API". `scripts/check-node-surface.js` closes that gap statically, so it
needs no second interpreter installed:

```
node scripts/check-node-surface.js          # fails on any post-18 API
node scripts/check-node-surface.js --list   # what is banned, and what to write instead
```

It runs in CI before the matrix jobs, so the failure is immediate and names the API.
