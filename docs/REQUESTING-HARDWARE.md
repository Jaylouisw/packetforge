# Requesting hardware

PacketForge is a catalog-driven simulator. Every device is one JSON file, and the
project is only as useful as the hardware it can model — so **requests are the
main way this project grows**, and they are welcome.

## File a request

[**Open a hardware request →**](https://github.com/Jaylouisw/packetforge/issues/new?template=device_request.yml)

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

1. **Automatic acknowledgement.** A workflow labels the issue `device-request` and
   comments with what is present and what is missing. Nothing waits on a human to
   tell you the datasheet link is blank.
2. **Triage.** `node scripts/request-queue.js` lists every open request, checks
   each against the catalog (so duplicates are caught), and separates "ready to
   implement" from "waiting on the requester".
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

`router` · `switch` · `l3-switch` · `firewall` · `wireless` · `ptp` · `olt` ·
`ont` · `modem` · `powerline` · `server` · `nas` · `desktop` · `laptop` · `phone` ·
`printer` · `camera` · `nvr` · `iot` · `host` · `cloud`

Anything that is internet-connected and networked is in scope: phones, laptops,
servers, printers, cameras, recorders, powerline and MoCA adapters, cable modems,
ONTs and OLTs, transceivers. If it has a port, a radio, or a cable, it belongs.

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

To close the loop on a merged request, reference the issue in the commit
(`closes #12`) so the requester is notified automatically.
