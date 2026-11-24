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

1. **The form is the first check, and no comment announces it.** The request is a YAML issue
   form, `.github/ISSUE_TEMPLATE/device_request.yml`, and every field the entry is built from -
   vendor, exact model, category, ports and the datasheet URL - is `required`, so a request
   cannot be filed with a blank datasheet. Nothing waits on a human to point that out later, and
   nothing says it either: no workflow in `.forgejo/workflows/` triggers on an opened issue, and
   no script comments at filing time. The form's own `title:` and `labels:` lines are what put
   `[Device]: ` in front of the title and `device-request` on the issue, and neither is
   load-bearing on its own: `scripts/request-queue.js` selects on a `[Device]:` or `[Hardware]:`
   title as well as on the label, so a request cannot go unread because a label was not applied.
   The first automated comment arrives with the push-to-main device sweep, and only when the
   catalogue already has the model - it names the spec file and closes the request
   ([DEVICE_REQUEST_SWEEP.md](DEVICE_REQUEST_SWEEP.md)).
2. **Triage.** `node scripts/request-queue.js` lists every open request, checks
   each against the catalog (so duplicates are caught), and separates "ready to
   implement" from "waiting on the requester" and from "blocked on a field the
   vendor does not publish". The last group is the one where every form field is
   answered and the device still cannot be written honestly - a chassis whose
   port count is a function of the cards ordered, for instance. Those carry the
   `blocked-on-build` label, and the queue quotes the maintainer's own sentence
   from the thread rather than summarising it, so the reason is always the
   evidence rather than a paraphrase of it.
3. **The device is written** as `devices/<vendor>/<model>.json`. No code changes
   are needed for a new model, ever.
4. **CI checks it** — `test/hardware-invariants.test.js` runs over the whole
   catalog and fails if:
   - the description promises optical ports that no interface provides
   - two ports share a name
   - an optical cage accepts plain copper cabling
   - a device has a PoE budget but no port to source power from
   - the device cannot be cabled to a copy of itself (an island, useless in a lab)
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

`router` · `switch` · `l3-switch` · `firewall` · `ap` · `ont` · `host` · `server` ·
`wireless` · `ptp` · `cloud` · `olt` · `splitter` · `modem` · `powerline` · `nas` ·
`desktop` · `laptop` · `phone` · `tablet` · `printer` · `camera` · `nvr` · `iot` · `tap`

Anything that is internet-connected and networked is in scope: phones, laptops,
servers, printers, cameras, recorders, powerline and MoCA adapters, cable modems,
ONTs and OLTs, transceivers. If it has a port, a radio, or a cable, it belongs.

`splitter` and `tap` count too, although neither holds an address: a passive
optical split and a network tap are devices the physical layer models, so a
request for one is worth filing like any other.

## For maintainers

```bash
node scripts/request-queue.js                  # the queue, grouped by readiness
node scripts/request-queue.js --json           # machine-readable
node scripts/request-queue.js --skeleton 12    # JSON stub for request #12
```

The skeleton command prints a stub with the vendor, model, category and source
URL already filled from the issue, plus the path it should be written to. Paste in
the real interfaces from the datasheet, run `npm test`, and the invariants will
tell you if the ports and the description disagree.

A request labelled `blocked-on-build` is never counted ready and never listed under
"ready to implement". `--skeleton` still runs on one, but it warns first: the stub
is an empty chassis written as a one-port box, and filling it from the datasheet's
maxima is how a spec ends up promising ports the hardware does not carry. State the
build instead - see [DEVICE_SCHEMA.md](DEVICE_SCHEMA.md) § "A port list may be a
stated build".

### What hardware is missing? Ask the labs

The catalogue follows the labs: a topology that names a model we do not have is
the clearest request the project can receive.

```bash
node scripts/missing-devices.js              # scan examples/, report only
node scripts/missing-devices.js lab5.json    # one topology, or a whole directory
node scripts/missing-devices.js --stubs      # write research/incoming/missing-<vendor>.json
node scripts/missing-devices.js --json       # machine-readable
```

It exits 1 as soon as a lab references a model that is not in `devices/`, which
is why CI runs it over `examples/`: a lab cannot merge alongside hardware the
simulator does not have. Without `--stubs` it writes nothing at all.

`--stubs` produces a form, not a device. `category` is `unknown` unless the model
string names the type outright, `capabilities` is the `["host"]` placeholder and
`interfaces` is empty with a note saying why. That is deliberate — the port list
is the field the physical layer trusts, and an invented one creates a device that
refuses cabling the real hardware accepts. Fill the ports in from a datasheet,
then run `node scripts/import-devices.js --apply`. Re-running `--stubs` never
overwrites what you have already filled in.

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
