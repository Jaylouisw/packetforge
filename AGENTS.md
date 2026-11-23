# AGENTS.md

How an agent works in this repository. Human contributors: `CONTRIBUTING.md` and
`docs/MAINTAINING.md` are yours; this file is the machine-facing version of the same rules.

## Agent skills

### Issue tracker

Issues live in the Forgejo tracker at `git.jayw.uk/jaylouisw/packetforge` (API base
`http://odin:3000/api/v1`), read and written over the API with the token in
`C:/Users/jay/AppData/Local/hermes/secrets/forgejo.token`. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, plus this repo's two domain labels (`device-request`,
`blocked-on-build`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` at the root, decisions in `docs/adr/`. See `docs/agents/domain.md`.

## The working loop

One issue, one branch, one PR. A PR body opens with `Fixes #N` when it closes an issue —
Forgejo closes the issue on merge, which is the only close-out that survives review — or
`Refs #N` when it does not. Nothing merges with a red check.

Before every push:

```
node scripts/syntax-check.js
node scripts/audit-port-types.js
node scripts/run-tests.js          # the whole suite; a single suite is `node test/<name>.test.js`
```

## The invariants that bite

- **Evidence, not invention.** Every field of a device spec traces to a vendor source URL
  recorded in the spec's `sources`. An empty array is a question; a guessed array is a bug
  that only shows up when a lab refuses to cable.
- **Pasteability.** Any command a view prints must be typeable back into the session that
  printed it — exec, global config or a named interface block — without `% Unrecognized`.
- **Refusals name the way forward.** A `%` message says what was wrong and what to type
  instead; a refusal that only says "invalid" is a defect.
- **Generated files are generated.** `docs/DEVICE_REGISTRY.md` and the wiki pages come from
  the scripts that own them; regenerate, never hand-edit.
- **A stated build is not a guess.** A chassis may be modelled as the board complement the
  vendor itself prints, with that complement in `label` and the slot row in `notes` — never
  in `model`, never invented. See `docs/DEVICE_SCHEMA.md`.
