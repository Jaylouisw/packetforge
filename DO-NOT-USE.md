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

`.staged/` here is an old import staging area; the devices it holds are already in the
catalogue. Nothing in this directory is authoritative.
