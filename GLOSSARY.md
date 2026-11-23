# Glossary

The words this codebase already uses, and what they mean here. Every entry names the file
that owns the term, so a reader can go from the word to the code that decides it. These are
not suggestions for new vocabulary — they are the vocabulary that is already load-bearing in
test names, field names and refusal messages.

## The catalogue

**Device / spec** — one JSON file under `devices/<vendor>/<model>.json` describing a piece of
hardware: its ports, its capabilities and the sources that say so. *Adding a manufacturer is
a data change, not a code change.* (`docs/DEVICE_SCHEMA.md`)

**Catalogue** — the whole `devices/` tree: what the simulator can draw and cable. Regenerated
statistics live in `docs/DEVICE_REGISTRY.md`, which is generated, never hand-edited.

**Registry** — `devices/registry.js`, the loader that scans the tree and exposes every spec.
It refuses an illegal filename, a duplicate spelling of one model, and a description that
contradicts the ports. (`docs/DEVICE_SCHEMA.md` § What the loader refuses)

**Capability** — a token from the engine's own list (`engine/device.js`, `CAPABILITIES`):
`host`, `l2-forward`, `l3-forward`, `cli`, `dhcp-server`, `dhcp-client`, `nat`, `firewall`,
`wireless`, `http-server`, `poe-pse`, `poe-pd`. A spec declares the ones it has; the console
refuses a verb whose capability is missing, and names it —
`cannot switch frames: it has no l2-forward capability`.

**Interface / port** — one entry in a spec's `interfaces` array: `name`, `type`,
`connector`, `speed`, `role`, `poeOut`. Interfaces are what a cable attaches to; a *board* is
the device that holds them.

**Connector / cage** — the physical receptacle: `rj45`, `sfp+`, `qsfp28`, `sc-apc`. Media
compatibility lives in `engine/media.js`, which classifies each connector by family so a
cage and a transceiver can be judged against one another.

**Stated build** — a chassis modelled as the board complement the *vendor itself* prints,
with that complement named in `label` and the slot row cited in `notes`, never in `model`.
Distinct from a guess: the build is quoted, not composed. (`docs/DEVICE_SCHEMA.md` § A port
list may be a stated build)

**Device request** — an issue titled `[Device]:` asking for a manufacturer or model. Carries
`device-request`; carries `blocked-on-build` when the vendor publishes the field's *type* but
not its *value*, which is the only honest reason such a request stays open.

## The console

**Session** — `CliSession` in `engine/cli.js`: one operator's view of one device, with a mode
and a device prompt.

**Mode** — `exec` (`>`), `enable` (`#`), `config` (`(config)#`), `iface` (`(config-if)#`).
`configure terminal` needs `enable`, like every other privileged verb; `disable` walks back
down. Reads work in both exec levels. (`engine/cli.js`, `MODE_*`)

**View** — a `show` command's answer, printed as a table. A view may be asked at an instant.

**Refusal** — the `%` line a command answers when it will not run. It names what was wrong
*and the way forward*; a bare "invalid" is a defect, not a refusal.

**Receipt** — the one-line confirmation a configuration verb prints, naming the object it
changed. A verb that changes something and prints nothing is unverifiable from the console.

**Pasteability** — the rule that any command a view prints must be typeable back into the
session that printed it, in that same mode, without `% Unrecognized`. It is what makes a
running-config a document rather than a screenshot.

**Instant** — a moment pinned on the simulation clock. `runAtMs` is `Infinity` unless a run
pinned one (`ping … at`, `converge at`), which is why an ageing table reads `-` until
something asks at a time.

## The machinery

**Flow** — a conversation between two endpoints traced through the topology
(`engine/flow.js`): TCP four-way or UDP, with the events it produced. `ping`, `openFlow` and
the canvas all read the same flow machinery.

**Topology** — the graph of devices and cables (`engine/topology.js`), and the unit the
server persists and the canvas draws.

**Suite** — one `test/*.test.js` file: a standalone Node script that prints
`<n> passed, <m> failed` and exits non-zero on failure. `scripts/run-tests.js` runs them all,
one process each, so no suite can leak state into the next.

**Guard** — a suite (or a script under `scripts/`) whose job is to stop a class of defect
coming back rather than to test a feature: `canonical-urls`, `spec-vs-description`,
`doc-catalog-counts`, `hardware-invariants`, `check-control-bytes`.
