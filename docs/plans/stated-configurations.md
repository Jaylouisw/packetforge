# Plan: seven of the ten open requests are one decision away, and the queue calls them ready

Status: forward plan. Measured on `99c2dee6`, 2026-11-17. Steps 1 and 2 have since landed
(`docs/DEVICE_SCHEMA.md` § "A port list may be a stated build"; the E6608, E6608T and E6616 now carry
their complement in `label`), so the "What exists today" table below is the state before them. Steps 4-5 close #797 and #799;
step 6 unblocks #807, #808 and #810. Nothing here changes an engine rule, a test or a workflow.

Every open device request carries the same maintainer sentence - *"blocked on a stated
configuration"* (#799, #804 on 2026-11-10; #743 twice). The project already knows the answer: name
the card complement, as `docs/RESOLUTIONS.md:15` says (`OptiXtrans E6616 (14x B1LDCD)`). What is
missing is not research - the census work is done and on disk - but (a) a schema rule, (b) one
product decision about an OTN port type, and (c) a queue that stops calling unbuildable requests
"ready".

## What exists today

**The convention**, at scale. 44 catalogue entries state a card complement; 42 put it in `label`
only, and exactly two put it in `model`:

| entry | `model` | `label` |
|---|---|---|
| `devices/arista/7504r.json` | `7504R` | `7504R (4x 36CQ)` - the precedent, 144 ports |
| `devices/huawei/netengine-8000-x4.json` | `netengine-8000-x4` | `... 8000 X4 (4x LPUI-4T, 32x 400GE)` |
| `devices/huawei/optixtrans-e6616.json` | **`OptiXtrans E6616 (14x B1LDCD)`** | `... 14x B1LDCD (...)` |
| `devices/huawei/optixtrans-e6608.json` | **`OptiXtrans E6608 (6x B1LDCD, DC chassis)`** | `... DC chassis, ...` |

`netengine-8000-x4.json`'s `notes` give the reason in prose - *"Port census is a stated build, not a
fixed chassis figure"* - and `test/device-aliases.test.js:5` calls "a card complement in the model"
one of the three naming conventions the alias tier exists to paper over.

**The research.** `research/huawei-netengine-8000-m-series-slots.md` has the M8 slot row (`PIC 1-8`,
no fixed-interface slot) and a 60-card census with the port count in each part name.
`research/optixtrans-slot-census.md` has all five OptiXtrans slot counts per model, per power
arrangement, and per protection mode; `research/optixtrans-board-census.md` has the E9600 board
matrix and per-board port counts, and concludes that two of the remaining five need a *port type*,
not a source; `research/optixtrans-e6600-xt-census.md` records that the E6600 board list is only in
the closed hedex tree.

**What is not there.**

- `docs/DEVICE_SCHEMA.md:30` defines `label` as "what the UI shows, with the SKU in parentheses".
  Across 259 lines the page never mentions a build, a card complement or a slot count.
- `scripts/request-queue.js:103-107` decides "ready" from four form fields - vendor, model,
  datasheet URL, port list. Today: **`open: 10  ready: 10  waiting on requester: 0  already
  catalogued: 0`**.
- `--skeleton 799` emits `devices/huawei/netengine-8000-m14.json` with `"capabilities": []` and one
  `eth0` 1G port: a 19-slot chassis as a one-port box.
- `engine/media.js:831-860` classifies a port into antenna/console/usb/coax/dsl/powerline/serial
  by `type`, then falls through to copper-or-fibre by name and speed. No family names OTN or WDM,
  so `type: "otn"` is drawn and cabled as an ordinary optical Ethernet link.
- `scripts/check-closed-issues.js` accepts *naming a file* as evidence, and a file can be one build
  of the chassis the request asked about.

## What is missing, ranked by what a PR can actually do

| rank | blocker | requests | state |
|---|---|---|---|
| 1 | nothing - the build is written down | #797 M8, #799 M14 | slot row and card census are on disk; both are Ethernet PIC chassis |
| 2 | a port type the engine does not have | #807 E9605, #808 E9612, #810 E9624 | board list and port counts settled; every port is an OTU line port, not Ethernet |
| 3 | the vendor never published it | #803 E6616X, #804 E6608T | E6600 board list is hedex-only; the E6608T's cross-connect row is `NA`, so it is a photonic shelf |
| 4 | the vendor never published it | #742, #743 OceanProtect | front-end port *types* and a controller count, not ports per controller |
| 5 | the tool lies about all of the above | all ten | `ready: 10` |

Rank 5 is the one that costs work: a worker who trusts the queue takes `--skeleton 799` and fills a
chassis from its datasheet maxima - exactly what `docs/MAINTAINING.md:110-118` says not to do, and
something `test/spec-vs-description.test.js` cannot catch, because the description would agree with
the invented ports.

## Ordered steps

1. **S - The schema says a port list may be a build.** Section in `docs/DEVICE_SCHEMA.md` after the
   `label` row: the complement goes in `label`, never in `model`; `notes` must state the slot count,
   the board part number and the table it came from. Cite `7504r`, `x4`, `e6616`. Docs only.
2. **S - One home for the complement.** Move the complement out of `model` for `optixtrans-e6608`
   and `optixtrans-e6616` into `label`, leave the port lists alone. Their `aliases` already carry
   the bare names (`E6616`, `OptiXtrans E6616`), so nothing becomes unfindable - that is the check
   to run, not a change to make.
3. **S - The queue reads the blocker.** `scripts/forgejo-api.js` has `listOpenIssues` and
   `scanRequests` but no comments read; add one, and have `request-queue.js` report a request whose
   latest maintainer comment says "blocked on" as `blocked-on-build` with the research page,
   instead of `ready`. Target: `ready: 10` becomes `ready: 2  blocked-on-build: 8`.
4. **M - NetEngine 8000 M8.** `devices/huawei/netengine-8000-m8.json`, label
   `NetEngine 8000 M8 (8x CR5D00LAXF90, 80x 10GE)`, notes quoting the `PIC 1-8` row and the card's
   printed port count. Closes **#797**.
5. **M - NetEngine 8000 M14**, slot row `PIC 1-14`, one card type, same shape. Closes **#799**.
6. **needs Jay's approval - an OTN port type.** The decision is small and one PR wide: declare a
   media family for `otn`/`wdm` in `engine/media.js` beside `serial` and `coax`, so a line port is
   not offered as an Ethernet cage, and say in `DEVICE_SCHEMA.md` that a stated configuration may
   use it. Until this exists, #807, #808 and #810 cannot be modelled honestly - their only ports
   are OTU line ports - and #803 and #804 stay blocked on the E6600 board list regardless.
7. **S - Pin the convention.** `scripts/audit-devices.js` (or a hygiene test) fails an entry whose
   `notes` match `/stated (build|configuration)|fully populated/i` but whose `label` has no
   parenthesised complement, and prints the count in its existing summary.
8. **needs Jay's approval - machine-readable configuration.** Optional `configuration` object
   (`{ slots, boards: [{ part, count }], sourceUrl }`) so the UI can offer a second build of the
   same chassis without a second file. New schema surface; not in this stream's scope.

## Risks

- **Maxima read as a port list.** `docs/MAINTAINING.md:110-118`: *"up to 16x10GE"* is not a port
  list. A stated build is safe only because the card's own part name carries its count.
- **Licence-gated ports.** Steps 4-5 pick card types with no RTU dependency; a 100GE-on-licence
  card would overstate the box by exactly the licensed fraction.
- **Search regression** from step 2. `test/device-aliases.test.js` forbids an alias equalling
  another device's model, and the inspector suites rank by prefix - run both before and after.
- **Sibling confusion.** The M8 must not shadow the F8 or the X8, and the E6608T must not be
  mistaken for the E6608. `sweep-device-requests.js` guard 8 (`variantOfSameCode`) already refuses
  to close one against the other, so a premature entry shows up as a stuck request rather than a
  wrong close - which is also why step 6 must land before any OptiXtrans spec does.
- **Step 3 touches the tool a maintainer acts on.** A false "blocked" hides a buildable request, so
  the rule reads only a maintainer comment that starts with "blocked on" and prints it verbatim.

## Test strategy

`npm test` first - `spec-vs-description`, `catalogue-hygiene`, `device-aliases`, `sweep-requests`
and `inspector-port-count` are the suites that bite. Then `node scripts/audit-devices.js` (step 7
adds a line to it), `node scripts/sweep-device-requests.js --limit 700` (report only: the eight
blocked requests stay open, `already in the catalogue: 0`), and `node scripts/check-closed-issues.js`
after each close so the comment naming the new file is the evidence the audit wants. Record the
queue's before/after counts in step 3's PR body - the number is the whole point of the change.

## Issues this would close

| issue | device | step |
|---|---|---|
| #797 | NetEngine 8000 M8 | 4 |
| #799 | NetEngine 8000 M14 | 5 |
| #807 / #808 / #810 | OptiXtrans E9605 / E9612 / E9624 | 6, then one spec each |

## Deliberately left out

#803 and #804: the E6600 board list is not reachable anonymously, so there is no order to state and
no PR can close them (`research/optixtrans-e6600-xt-census.md` records where the search stopped).
#742 and #743: Huawei publishes front-end port types and a controller count, not ports per
controller. #130 (UDW-PRO) has no vendor page at all and is unrelated to any build. Chassis-and-board
modelling in the engine - cards as installable objects, a topology that changes when you fit one -
is a new data-plane concept and out of scope; the stated configuration is the cheap answer that
closes the requests without it.
