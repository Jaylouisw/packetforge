# Requesting hardware

PacketForge is a catalog-driven simulator. Every device is one JSON file, and the
project is only as useful as the hardware it can model — so **requests are the
main way this project grows**, and they are welcome.

## File a request

**Where to file it.** The queue analysed on this page is the forge's. The GitHub mirror carries its own,
much older one — **787 open issues against these 24 device requests**, measured on 2026-11-12 — and
`scripts/gh-bridge.js --issues` is what moves a GitHub issue across, only when a maintainer runs it.
Filing on the forge puts the request in the queue this page describes immediately; filing on GitHub
puts it next to the code you may already have forked. [CONTRIBUTING.md](../CONTRIBUTING.md) has the
numbers and the reasoning.

[**Open a hardware request →**](https://git.jayw.uk/jaylouisw/packetforge/issues/new?template=device_request.yml)

The form has **eight fields plus a pre-submit checklist**, and the table below says what each one is
worth. Two of them carry most of the weight:

| Field | Why it matters |
|---|---|
| **Datasheet or product page URL** | The whole entry is built from it. Without one we cannot verify port counts, and we will not guess. Required. |
| **Ports and interfaces** | This decides whether the simulated device behaves like the real one. A switch with 4 SFP+ uplinks modelled as 24 copper ports will *refuse* a fibre link the real hardware accepts. Required. |
| Vendor + exact model | Needs to match the datasheet, not a family name. Both required. |
| Category | Sets which behaviours apply (routing, PoE, wireless…). Required, and it is a 22-option dropdown — `Other / not sure` is a real option rather than a failure. |
| PoE budget | Only if it sources power. Lets a switch's budget actually be tested. Optional. |
| What you want to model with it | Optional, and it decides scope: a full L2/L3 box or only its physical ports. |
| Capabilities | Optional — routing, switching, PoE, wireless, NAT, DHCP; most are inferred from the category. |
| Before submitting | Two required acknowledgements: the model is not already in the catalogue or the tracker, and the port list came from a datasheet rather than memory. |

If you already have the JSON, skip the form and open a PR — see
[DEVICE_REGISTRY.md](DEVICE_REGISTRY.md).

### What the form does, measured

Two things about the form are worth stating because neither is visible from the page:

- **The labels.** `.github/ISSUE_TEMPLATE/device_request.yml` declares
  `labels: ["device-request", "device", "enhancement"]`. The 24 open requests carry the first two and
  **none** carries `enhancement`, so a query filtered on that label finds nothing while the template says
  it will be there. No page depends on it — the triage sweep finds requests by *title prefix*
  (`[Device]`), never by label — but do not write a filter that assumes it.

  The forge carries **six** labels in total — `bug`, `device`, `device-request`, `enhancement`,
  `needs-datasheet`, and `from-github`, the last one created by `gh-bridge.js` itself
  (`ensureLabel('from-github', '#1f6feb', 'Opened on the GitHub mirror')`) rather than by any
  configuration file. `.github/labels.yml` declares thirteen, but **nothing syncs it**: its header
  named `.github/workflows/labels.yml`, which went with the rest of that directory in #1059, and no
  script, workflow or npm alias in the tree reads it — so eight of its thirteen
  (`feature`, `documentation`, `ci`, `question`, `good first issue`, `help wanted`, `duplicate`,
  `wontfix`) have never existed on the forge. One of them is asked for by a shipped template:  
  `.github/ISSUE_TEMPLATE/feature_request.yml` declares `labels: [feature]`, so a feature request is
  filed untagged, while `enhancement.yml` lands with the label it asks for.
- **The link needs an account.** `GET/issues/new?template=device_request.yml` answers **303** to an
  anonymous client, so the form's rendering is not something this repository can verify; a maintainer
  with a session sees it, and the checked-in YAML is the only thing under review here. If you change the
  template, open the form once by hand.

Closed issues in this tracker carry no labels at all (measured: a sample of 50 of the closed ones has
**none** — 50 fetched, 0 labelled), so label counts describe the *open* queue only — which is the queue
the sweep reads. The closed count is a moving figure and quoting it is a losing game: it read `1,461`
items with pull requests included and `940` issues on their own when this paragraph was last measured,
against `1,429` and `925` a reading earlier, then `1,421` and `921`, `1,413` and `917`, `1,411` and `916`,
`1,409` and `915`, `1,407` and `914`, `1,405` and `913`, `1,403` and `912`, `1,399` and `910`, `1,397` and
`909`, and `1,395` and `908` before those. Both halves climb together every time — the gap runs 487, 488,
489, 491, 494, 496, 500, 504, then 521 — so the drift is merged work arriving, not one side pulling ahead.
The open queue has not moved at
all in that time: every reading of it has said **24**, which is why it is quoted as a number and the
closed side is not. So measure both halves rather than remembering either:

```bash
H='https://git.jayw.uk/api/v1/repos/jaylouisw/packetforge/issues'
curl -s -D - -o /dev/null "$H?state=closed&limit=1"            | grep -i '^x-total-count'  # 1461, PRs included
curl -s -D - -o /dev/null "$H?state=closed&type=issues&limit=1" | grep -i '^x-total-count'  # 947 issues on their own
curl -s -D - -o /dev/null "$H?state=open&type=issues&limit=1"   | grep -i '^x-total-count'  # 28 open: 24 requests + 4 bugs
```

The gap between the first two numbers is the pull requests: Forgejo serves them through the issues
endpoint from a shared number space, so `type=issues` is what separates a request someone made from a
change someone proposed. Nothing above is truncated either — paging `state=closed&type=pulls` to an empty
page returns **528** rows, and the counts reconcile against the number space exactly as they did before, which is the
only part worth keeping: the highest number is **`#1507`**, **1,506** items are counted — 28 open issues + 948
closed issues + 529 closed pull requests + 1 open pull request — and `state=all` also reports **1,506**. So exactly
one number in 1 … 1,507 is missing, and it is still **`#1,223`**: `GET /issues/1223` answers `404` while `#1502`,
`#1505`, `#1506` and `#1507` all answer `200`. The totals move every day; the reconciliation is the invariant. That is the check worth repeating rather than the totals:
the counts say "no page limit", the enumeration says *which* number is missing, and a tracker with a
deleted item would otherwise look like an off-by-one forever.

## What happens next

1. **Acknowledgement — generated, not yet automatic.** `node scripts/request-queue.js` reads every
   open request, checks it against the catalog (so duplicates are caught) and says exactly which
   field is missing, so the reply you get names the blank datasheet link rather than asking you to
   look again. It needs `FORGEJO_TOKEN` in the environment and **exits `2`** without it, printing
   *"FORGEJO_TOKEN is not set - the tracker is not readable without it (this is not the same as \"no
   open requests\")"* — measured, because a non-zero exit that looks like an empty queue is how a
   silent tracker outage gets read as good news. What does **not** exist is the workflow that would post that reply on its own:
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
  number. A fabricated one silently blocks devices that should work.

  Be precise about what *unknown* buys, because it is weaker than it sounds. It is recorded as
  `poe: { "budgetUnknown": true }`, which resolves to **0 W** (`engine/device.js:132`), and the budget
  rule refuses to police a device whose budget is not greater than zero — `pseDraw()` returns `null`
  before it counts a single watt (`engine/validation.js:340`). So the check is off for that device,
  yes, but it is off for **every** zero-budget PSE, not only the explicitly-unknown ones: a switch
  whose figure was simply never declared is just as unpoliced, and the two are only distinguishable
  in `show power inline`, which prints the resolved budget **and its source**. One device in the
  catalogue takes the explicit route today; [PHYSICAL_LAYER.md](PHYSICAL_LAYER.md) has the resolution
  order and what each source means.

## Categories

`router` · `switch` · `l3-switch` · `firewall` · `wireless` · `ptp` · `olt` ·
`ont` · `modem` · `powerline` · `server` · `nas` · `desktop` · `laptop` · `phone` ·
`printer` · `camera` · `nvr` · `iot` · `host` · `cloud` · `splitter` · `tap` ·
`tablet` · `ap`

That is **25** values, not the 21 this list used to carry — `splitter`, `tap`, `tablet` and `ap` were
missing, and they are not hypothetical: measured today the catalogue holds **17 splitters, 18 taps, 10
tablets and 11 access points** — re-measured on 2026-11-12 against 1,661 specs and every one of the four was
still exact, as was the **25** in the sentence before it (`test/hardware-invariants.test.js` printed
`25 passed, 0 failed`). Those counts move with every device PR, so run the one-liner below rather than quoting
this line. A request whose hardware is a PON splitter needs the value that exists, not the
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
while `--help` exits **0**. Nothing is silently ignored — unlike `request-queue.js` above, which takes
`--skeleton` and `--json` and quietly ignores anything else. (This sentence used to say its *only* flag was
`--skeleton`; that was the same leftover the section above admits to, and it survived one correction longer.) Two of the five are worth
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

All of the above was re-measured on 2026-11-12 rather than assumed, because the whole point of this section is
that a script's contract drifts silently: `--bogus` printed `Unknown flag: --bogus` plus the usage line and
exited **2**; `--help` printed the same usage line and exited **0**; a tokenless default run over `examples/`
printed `Scanning 4 topology file(s), 19 device reference(s).` / `Catalogue: 1661 models (devices)` then the
`not scanned: FORGEJO_TOKEN is not set …` block quoted above and `CI gate: passed.`, exiting **0**; the
`--no-issues` run said `issue scan disabled with --no-issues` instead and also exited **0**. Pointing it at a
scratch copy of `examples/lab1-two-pcs-switch.json` with one model renamed to `probe580-nonexistent-model`
exited **1** with `MISSING: 1 model(s) in 1 vendor(s)` and the `next:` line — so the gate is the topology scan,
exactly as claimed. One thing the block above cannot show because both lines land in the same terminal: which **stream** they
use. Measured with `spawnSync`, `--bogus` writes `Unknown flag: --bogus` and the usage line to **stderr**
and exits **2**, while `--help` writes the usage line to **stdout** and exits **0** — so
`node scripts/missing-devices.js --bogus 2>/dev/null` prints nothing at all, and a script that greps its
own stdout for a usage line will miss the error case entirely. Re-measuring it also re-demonstrated the
warning below: `node scripts/missing-devices.js --bogus; echo rc=$?` answered `rc=0` in this shell for a
command that really exits 2.

The same run also shows why exit codes here have to be read with `&&`/`||` or `spawnSync`:
see the exit-code note near the end of the tracker section in [TRIAGE.md](TRIAGE.md).

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
