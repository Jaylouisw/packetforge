# Requesting hardware

PacketForge is a catalog-driven simulator. Every device is one JSON file, and the
project is only as useful as the hardware it can model — so **requests are the
main way this project grows**, and they are welcome.

## File a request

[**Open a hardware request →**](https://git.jayw.uk/jaylouisw/packetforge/issues/new?template=device_request.yml)

The form asks for five things. Two of them actually matter:

| Field | Why it matters |
|---|---|
| **Datasheet or product page URL** | The whole entry is built from it. Without one we cannot verify port counts, and we will not guess. |
| **Ports and interfaces** | This decides whether the simulated device behaves like the real one. A switch with 4 SFP+ uplinks modelled as 24 copper ports will *refuse* a fibre link the real hardware accepts. |
| Vendor + exact model | Needs to match the datasheet, not a family name. |
| Category | Sets which behaviours apply (routing, PoE, wireless…). |
| PoE budget | Only if it sources power. Lets a switch's budget actually be tested. |

If you already have the JSON, skip the form and open a PR — see
[DEVICE_REGISTRY.md](DEVICE_REGISTRY.md).

## What happens next

1. **Acknowledgement — generated, not yet automatic.** `node scripts/request-queue.js` reads every
   open request, checks it against the catalog (so duplicates are caught) and says exactly which
   field is missing, so the reply you get names the blank datasheet link rather than asking you to
   look again. What does **not** exist is the workflow that would post that reply on its own:
   `.forgejo/workflows/` holds only `ci.yml` and `auto-rebase.yml`, and neither triggers on issues,
   so the `device-request` label and the comment come from a maintainer running the script.
2. **Triage.** The same report separates "ready to implement" from "waiting on the requester"; a
   maintainer works the first list.
3. **The device is written** as `devices/<vendor>/<model>.json`. No code changes
   are needed for a new model, ever.
4. **CI checks it** — `test/hardware-invariants.test.js` runs **25** assertions over the whole
   catalog (not just your file). Among them, it fails if:
   - the description promises optical ports that no interface provides
   - two ports share a name
   - an optical cage accepts plain copper cabling
   - **a port claims a line rate its cage cannot carry** (10G on a 2.5G SFP slot)
   - a device has a PoE budget but no port to source power from, or the budget is not a plausible
     wattage
   - a device has zero interfaces, or cannot be cabled to a copy of itself (an island, useless in a
     lab) — except the classes that legitimately have one uplink, which are named in the check
   - the "known gaps" list has an entry that no longer refers to anything
5. **It ships** in the next release, and the request is closed with a link to the
   file that was added.

## Honest expectations

- **Requests with a datasheet get implemented.** Requests without one usually
  stall, because the alternative is inventing hardware.
- There is **no promised timeline.** This is a spare-time project. Small,
  well-sourced requests move fastest.
- **"Same as model X but bigger" is not enough.** Port counts are the thing that
  changes between variants, and it is the thing we cannot guess.
- If a device genuinely publishes no figure for something — a PoE budget, for
  instance — it is recorded as *unknown* rather than filled with a plausible
  number. An unknown budget switches enforcement off for that device. A fabricated
  one silently blocks devices that should work.

## Categories

`router` · `switch` · `l3-switch` · `firewall` · `wireless` · `ptp` · `olt` ·
`ont` · `modem` · `powerline` · `server` · `nas` · `desktop` · `laptop` · `phone` ·
`printer` · `camera` · `nvr` · `iot` · `host` · `cloud` · `splitter` · `tap` ·
`tablet` · `ap`

That is **25** values, not the 21 this list used to carry — `splitter`, `tap`, `tablet` and `ap` were
missing, and they are not hypothetical: the catalogue holds 16 splitters, 9 taps, 10 tablets and one
access point today. A request whose hardware is a PON splitter needs the value that exists, not the
nearest one that used to appear on this list:

```bash
node -e "const{loadCatalog}=require('./devices/registry');const c=loadCatalog(require('path').resolve('devices')).filter(d=>!d.error);const m={};for(const d of c)m[d.category]=(m[d.category]||0)+1;for(const [k,v] of Object.entries(m).sort((a,b)=>b[1]-a[1]))console.log(v,k)"
```

Most categories map to a palette bucket in the UI (`router`, `switch`, `l3-switch`, `firewall`, …), but
not all of them do: the palette collapses 25 `category` values into 24 buckets, so a spec's category is
a fact about the device first and a colour second.

Anything that is internet-connected and networked is in scope: phones, laptops,
servers, printers, cameras, recorders, powerline and MoCA adapters, cable modems,
ONTs and OLTs, transceivers. If it has a port, a radio, or a cable, it belongs.

## For maintainers

```bash
node scripts/request-queue.js                  # the queue, grouped by readiness
node scripts/request-queue.js --skeleton 12    # JSON stub for request #12
```

There are **two** flags, and this page said for a while that there was one — an earlier version
correctly reported no `--json`, then `--json` was added and the correction outlived the fact:

| Flag | What it does | Where |
|---|---|---|
| `--skeleton <n>` | prints a JSON stub for request `#n`, with vendor, model, category and source URL already filled in | `argv.indexOf('--skeleton')` |
| `--json` | prints the whole queue as JSON instead of the grouped text report | `argv.includes('--json')`, then `JSON.stringify(queue, null, 2)` |

`--skeleton` wins if both are present: the stub branch (`skelIdx !== -1`) runs before the `--json`
branch, so `--json --skeleton 12` gives you the stub, not the queue. Anything else on the command line
is ignored. If you want the raw queue without either flag, read the API directly with the `curl` in
[TRIAGE.md](TRIAGE.md).

**Every invocation needs `FORGEJO_TOKEN`.** Without it the script stops before parsing anything and
exits **2**, with a message that is worth reading rather than skimming because it names the mistake
people make:

```
Could not read issues from jaylouisw/packetforge.
FORGEJO_TOKEN is not set - the tracker is not readable without it (this is not the same as "no open requests")
```

The skeleton command prints a stub with the vendor, model, category and source
URL already filled from the issue, plus the path it should be written to. Paste in
the real interfaces from the datasheet, run `npm test`, and the invariants will
tell you if the ports and the description disagree.

### What hardware is missing? Ask the labs

The catalogue follows the labs: a topology that names a model we do not have is
the clearest request the project can receive.

```bash
node scripts/missing-devices.js              # scan examples/, report only
node scripts/missing-devices.js lab5.json    # one topology, or a whole directory
node scripts/missing-devices.js --stubs      # write research/incoming/missing-<vendor>.json
node scripts/missing-devices.js --json       # machine-readable
node scripts/missing-devices.js --no-issues  # skip the issue scan entirely
node scripts/missing-devices.js --strict     # also fail when an open request names a model we lack
```

There are four flags plus help (`--stubs`, `--json`, `--no-issues`, `--strict`, `-h`/`--help`), and the
script validates them: an unknown one prints `Unknown flag: --bogus` with the usage line and exits **2**,
while `--help` exits **0**. Nothing is silently ignored — unlike `request-queue.js` above, whose only
flag is `--skeleton` and whose extra arguments vanish. Two of the five are worth
understanding before a CI run surprises you:

- **The default run also scans the tracker**, not just the topologies. That needs `FORGEJO_TOKEN`, and
  without one it does not fail — it prints its own line and carries on:

  ```
  Open device-request issues:
    not scanned: FORGEJO_TOKEN is not set - the tracker is not readable without it (this is not the
    same as "no open requests") -- the topology scan above is unaffected.
  CI gate: passed.
  ```

  `--no-issues` says the same thing without the token lookup. Either way the exit code reflects the
  **topology** scan only, so a green run does not mean the tracker was read.
- **`--strict` moves the gate.** Normally the issues section is informational and only a missing model
  fails the run; with `--strict` an open request for a model the catalogue lacks fails it too.

It exits 1 as soon as a lab references a model that is not in `devices/`, which
is why CI runs it over `examples/`: a lab cannot merge alongside hardware the
simulator does not have. Without `--stubs` it writes nothing at all.

`--stubs` produces a form, not a device. `category` is `unknown` unless the model
string names the type outright, `capabilities` is the `["host"]` placeholder and
`interfaces` is empty with a note saying why. That is deliberate — the port list
is the field the physical layer trusts, and an invented one creates a device that
refuses cabling the real hardware accepts. Fill the ports in from a datasheet,
then run `node scripts/import-devices.js --apply`. Re-running
`node scripts/missing-devices.js --stubs` never overwrites what you have already
filled in: it reads the existing file, compares by model, and appends only the
models that are not in it (a file it cannot parse is left untouched and reported).

**The two scripts do not share flags, and one of them does not complain.** `--stubs`
belongs to `missing-devices.js`, which validates its flags. `import-devices.js`
accepts `--all`, `--apply`, `--write`, `--upgrade` and `--json` and **ignores
anything else silently** — measured, `node scripts/import-devices.js --stubs` prints
`Scanned 49 file(s), 670 spec(s)` / `Would add: 0  duplicates: 670` and exits **0**,
i.e. it performs a normal import and writes no skeleton at all.

To close the loop on a merged request, reference the issue in the commit
(`closes #12`) so the requester is notified automatically.

## How a spec reaches the catalogue

Research and review are separate steps on purpose, and the tooling enforces it.

1. **Write specs** to `research/incoming/devices-*.json`. One JSON object per model.
2. **Dry run** the importer:

   ```sh
   node scripts/import-devices.js
   ```

   This prints what *would* be added, which specs are duplicates of ones already
   vetted, and every rejection with the reason. It writes nothing.
3. **Import** deliberately, once the dry run looks right:

   ```sh
   node scripts/import-devices.js --apply
   ```

4. **Run the invariants** — they are the gate, not a formality:

   ```sh
   node test/hardware-invariants.test.js
   ```

### Why `--apply` is required

Writing used to be the default. Research agents ran the script bare, so specs went
from a language model's memory into the catalogue without anyone reading them, and
three classes of hardware error reached main that way (a USB port modelled as a
gigabit NIC, SFP+ uplinks downgraded to 1G, combo cages flattened to copper).

A dry-run default costs one extra word and buys a review point. If you are an
automated agent: **write JSON, do not import.** A human or CI applies it.

### Known gaps are tracked, not hidden

Some devices carry hardware facts that need a datasheet read to settle. Those live
in `test/known-issues.json` against a Forgejo issue. The invariant fails on any new
offender *and* fails if a listed device is fixed but not removed, so the list can
only shrink.
