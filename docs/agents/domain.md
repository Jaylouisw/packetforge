# Domain docs

How an agent should consume this repo's domain documentation before exploring code.

## Before exploring, read these

- **`GLOSSARY.md`** at the repo root — the vocabulary the code, tests and docs already use.
  Test names and interface vocabulary should match it.
- **`docs/adr/`** — read the ADRs that touch the area you are about to work in. They record
  decisions that look arbitrary in the code and are not: why a capability token exists, why
  a refusal is worded the way it is, why a catalogue row is a build rather than a part.

If either is missing, proceed silently. Don't flag the absence and don't propose creating
them upfront: `/domain-modeling` (reached through `/grill-with-docs` and
`/improve-codebase-architecture`) creates them lazily, when a term or a decision actually
gets resolved.

## Layout

Single-context repo — one vocabulary, one decision log, at the root:

```
/
├── AGENTS.md
├── GLOSSARY.md
├── docs/
│   ├── adr/
│   │   ├── 0001-a-catalogue-row-is-data-not-code.md
│   │   └── 0002-refusals-name-the-way-forward.md
│   ├── DEVICE_SCHEMA.md      ← the spec reference, not a glossary
│   └── plans/                ← forward plans, one page each
├── devices/                  ← the catalogue: one JSON file per model
├── engine/                   ← the simulator: one module per subsystem
└── test/                     ← one suite per behaviour
```

`docs/DEVICE_SCHEMA.md`, `docs/CLI.md` and `docs/SIMULATION.md` are references — they say
what the code does. `GLOSSARY.md` says what the words mean. When the two disagree, the code
is the truth and both files are wrong.

## Writing a new term

Add it to `GLOSSARY.md` only when the code already relies on it: a word that appears in a
test name, a field name or a refusal message. A term invented in prose and applied to code
is the doc-drift these files exist to prevent.
