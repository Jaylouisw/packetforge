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
npm test        # every suite
npm run smoke   # the HTTP API end to end
```

If the change makes a documented limitation untrue, update `docs/SIMULATION.md` in the same
PR - the matrix is a promise about the engine, and a stale one is worse than none.
