# This checkout is stale — do not analyse it or file bugs from it

Measure the gap instead of trusting a number written in this file, because the number rots with
every merge: `git fetch origin`, then `git rev-list --count HEAD..origin/main` for how far behind it
is, and `git rev-list --count origin/main..HEAD` for the work it carries that `main` does not.

On 2026-11-10 that measured **328 behind and 51 ahead** of `origin/main` — far enough behind to
predate the device-registry merge, the control-plane fixes and most test suites added since. Work
dispatched here has produced:

- five bug reports that were already fixed on main,
- two swarm batches whose results were already on main before they ran,
- a background job (proc_a2b6bbae3201) that failed on test files which do not exist here.

For a fresh checkout, clone the canonical home — the forge, not the mirror:

```
https://git.jayw.uk/jaylouisw/packetforge
```

GitHub carries a **read-only mirror** of this repository: the forge pushes to it and nothing is
merged there. Cloning the mirror, or opening work on it, is what produced the already-fixed bug
reports above — a change made over there does not flow back.

`.staged/` is an old import staging area, and the sentence that used to stand here — "the devices it
holds are already in the catalogue" — is false for **172 of its 589 tracked files**. Measured against
`devices/` file by file: **417** are byte-identical to the file at the same path, **38 differ**, and
**134 name a model the catalogue does not contain at all** (`ubiquiti/EAV-Fiber`, `ENAS`, `ER-12P`,
`NSM5`, `PBE-5AC-500`, …) — matched on the `model` field, not on the filename, so a rename cannot hide
one. Nothing reads the directory: `grep -rn '\.staged' --include=*.js .` finds no code, and
`loadCatalog()` is only ever pointed at `devices/`. So the staging area is neither authoritative nor
free of unique content — if you are chasing a model that exists nowhere else, look there before
concluding it was never imported.
