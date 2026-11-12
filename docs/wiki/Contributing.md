# Contributing

The most useful contribution is a **device spec**, and it does not require touching code.

## Adding a device

1. Copy an existing file in `devices/<vendor>/` with a similar shape.
2. Fill in what the vendor's documentation states, and record the documentation URL.
3. Run the gates:

```bash
node test/hardware-invariants.test.js
node scripts/audit-port-types.js
```

Those two are the gates that ask questions only a spec can answer — 25 invariants over the catalogue and a
contradiction sweep ("No port contradicts its declared type."). CI also runs four checks that are cheap to
run first, and two of them can bite a spec: `node scripts/check-control-bytes.js` refuses a stray control
byte, which is what a copy-paste out of a PDF can leave behind, and `node scripts/check-canonical-urls.js` refuses
a project URL that is not `https://git.jayw.uk/jaylouisw/packetforge`, which is easy to paste in from a
mirror. The other two — `check-node-surface.js` and `syntax-check.js` — are about JavaScript and
rarely fire on a JSON-only change. See `docs/CI.md` for the full list; green locally is not the same as
green in CI unless you ran the same set.

4. Open a PR. Say which datasheet you used, and say anything the datasheet does not answer.

## The rules that keep the catalogue honest

- **Never invent a port to make a count come out right.** If a datasheet says eight ports and
  the model has six, say so in the PR rather than adding two.
- **Never remove a port you cannot disprove.** Absence of evidence is not a correction.
- **A shared port position is one port.** An RJ45/SFP combo pair is a single position with
  two possible connectors, not two ports.
- **Unknown is a value.** If the PoE budget or the speed ladder is genuinely unpublished, say
  it is unknown; do not infer it from the model name.
- **A test that has to change to fit your change is telling you something.** Read it before
  you edit it.

## Code contributions

`engine/` is plain CommonJS with no dependencies, and every feature has a suite that asserts
behaviour rather than implementation. Before opening a PR:

```bash
npm test        # two guards, then every suite
npm run smoke   # 18 checks, the HTTP API end to end
```

If the change makes a documented limitation untrue, update `docs/SIMULATION.md` in the same
PR - the matrix is a promise about the engine, and a stale one is worse than none.
