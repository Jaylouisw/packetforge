# This checkout is stale — do not analyse it or file bugs from it

It is **371 commits behind `origin/main`** as of 2026-11-08, and predates the device-registry
merge, the control-plane fixes and every test suite added since. Work dispatched here has
produced:

- five bug reports that were already fixed on main,
- two swarm batches whose results were already on main before they ran,
- a background job (proc_a2b6bbae3201) that failed on test files which do not exist here.

The working checkout is **`C:\Users\jay\pf-int`**, or a fresh clone of
https://github.com/Jaylouisw/packetforge.

`.staged/` here is an old import staging area; the devices it holds are already in the
catalogue. Nothing in this directory is authoritative.
