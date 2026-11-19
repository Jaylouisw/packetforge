# Plan: LLDP reports itself ACTIVE, and no command can turn it off

Status: forward plan, no code. Measured on `31a0b297`, 2026-11-19. Closes **no** open issue - the queue's
nine open entries are all PRs (#130 device work, #803 research, and seven docs/device fixes). Scope:
`engine/lldp.js`, `engine/simulator.js` (`announceLldp()`, the receive branch), `engine/device.js`
(serialize/hydrate), `engine/cli.js` (config words, `show lldp`, running-config, `_help()`), `docs/CLI.md`,
`docs/SIMULATION.md` §5.9, and two new suites.

Distinct from `docs/plans/capability-vocabulary.md` (this proposes **no** new capability token - see Risks),
from `docs/plans/stp-port-tunables.md` (the same shape of gap on a different protocol), and from
`docs/plans/show-view-seams.md` (that plan is about where a view lives; this one is about a protocol having
no writer at all).

## What exists today

**The status block is real and cited.** `show lldp` prints four lines (`engine/cli.js:5906-5931`) taken from
Cisco's field notice on unknown-protocol drops; `show lldp neighbors` prints the table and
`Total entries displayed: N` (`:5943-6005`). `test/show-lldp-status.test.js:49-73` pins the block and asserts
the two views are not the same output.

**The wire is real.** `announceLldp()` (`engine/simulator.js:2540`) emits one LLDPDU per cabled, enabled port
at the start of each run - called from `refreshNeighbours()` (`:2526`), `_run()` (`:621`), `traceroute()`
(`:737`) and `:4087`. Receivers terminate it at the nearest bridge and store a record (`:3359-3378`), aged by
`Device.lldpRows()` (`engine/device.js:838`) against the TTL the neighbour advertised.

**Nothing can be configured.** Measured, one command at a time on a generic switch:

| typed | answer |
|---|---|
| `lldp run` in `(config)#` | `% Unrecognized config command: lldp run` |
| `no lldp run` | `% Unrecognized config command: no lldp run` |
| `lldp transmit` in `(config-if)#` | `% Unrecognized interface command: lldp transmit` |
| `no lldp receive` | `% Unrecognized interface command: no lldp receive` |
| `show lldp traffic` | `% show lldp does not take "traffic": the status view takes no word ...` |
| `show lldp neighbors detail` | `% show lldp neighbors does not take "detail": every neighbour on every port is listed ...` |

**The one gate is the receive map.** `if (!dev.lldp) continue;` (`engine/simulator.js:2542`), and `dev.lldp`
is the neighbour `Map` the constructor always creates (`engine/device.js:214`). It is truthy on every device,
so a PC with no cable in it still answers `Status: ACTIVE` (measured). The only thing that stops an
announcement is the port's administrative disable, and that takes the data path with it
(`activeInterfaces()` filters on `iface.enabled`, `engine/device.js:368-370`).

**The timers are constants.** `buildFrame()` accepts `opts.ttl` (`engine/lldp.js:56`) and the only caller
passes no options (`engine/simulator.js:2547`), so every LLDPDU advertises 120 s. `DEFAULT_TX_INTERVAL_S` is
printed, never used: one frame per run is not "every 30 seconds".

**Nowhere to keep a setting.** The serialised port document has no `lldp*` field
(`engine/device.js:1411-1450`), `hydrate()` copies a fixed list (`:1600`), and the running-config printer's
per-port block (`engine/cli.js:6769` onward) has no line. That is the #1405/#1321 defect class: a field absent
from all three is dropped on save.

**Documented as missing, three times.** `docs/CLI.md:2447-2453` - *"There is no `lldp run` here and no
per-port `lldp transmit` / `lldp receive`"*; `engine/cli.js:5917-5923` - *"inventing an `lldp run` would be
the feature this run is not allowed to add"*; `research/lldp-default-state.md`, section "Smallest honest
increment", which names the same three changes. `docs/SIMULATION.md:437-442` carries the §5.9 rows, and two
of its anchors are stale (`:1196-1209`, `:1766-1776`; the code is at `2540` and `3359`).

## What is missing or weak, ranked

1. **No global off switch.** The off-case the status block was copied from (`% LLDP is not enabled`) is
   unreachable, so `ACTIVE` is a claim made for all 2,356 specs `loadCatalog()` returns, hosts included.
2. **No per-port transmit/receive.** The real tool for an uplink to a non-LLDP peer; today the only lever is
   the port's administrative disable, and it takes the data path with it.
3. **Timers cannot be set.** `test/lldp-hold-time.test.js:131` has to hand-build a frame to exercise a
   non-default hold time, because no command can produce one.
4. **No `show lldp traffic`.** LLDP frames are counted as bytes only (`engine/flow.js:512` returns the
   payload size); there are no per-protocol, per-port counters, and the view refuses the word.
5. **No persistence path for any of it**, so the first PR that accepts `no lldp run` and forgets
   `serialize()` / `hydrate()` / running-config loses the setting on reload.
6. **§5.9's citations drifted ~1,300 lines**, which is how a reader concludes the section describes
   something else.

## Ordered steps

Steps 1-4 add command surface and are each marked for approval; step 5 is docs only.

1. **Global `lldp run` / `no lldp run`.** `dev.lldpEnabled` defaults true; gate `announceLldp()` and the
   receive branch on it; `show lldp` **and** `show lldp neighbors` answer the single line
   `% LLDP is not enabled` when off; running-config prints `no lldp run` only in the off state (our default
   differs from a factory Cisco, and `docs/CLI.md` says so); serialize + hydrate. **needs Jay's approval.**
   **S**
2. **Per-port `lldp transmit` / `lldp receive`.** `(config-if)#` words with `no` forms, both default on,
   stored on the port, honoured at `engine/simulator.js:2543` and `:3359`; running-config prints only the
   `no` line; state survives save/load. A row already heard is left to expire at its TTL, not deleted.
   **needs Jay's approval.** **S/M**
3. **`lldp timer <5-254>` and `lldp holdtime <2-10>`.** TTL = timer x multiplier, fed through
   `buildFrame()`'s existing `opts.ttl`; `show lldp` reads the live pair instead of the constants;
   out-of-range answers one `%` line naming the range; running-config prints non-defaults only.
   **needs Jay's approval.** **S**
4. **`show lldp traffic`.** Per-port frames out/in, discarded, errors, ageouts, incremented in
   `announceLldp()` and the receive branch; runtime-only, never serialised. `showNoTail` at
   `engine/cli.js:5934` gains a sibling. Two of the 15 `show lldp` suites assert the current refusal and
   change here. **needs Jay's approval.** **M**
5. **Docs and anchors.** §5.9's two anchors to `2540`/`3359`, the `Approximate` row rewritten now that a
   timer exists, `docs/CLI.md:2426-2453` rewritten without "there is no `lldp run` here", `_help()` lines at
   `engine/cli.js:7067-7068`, and `test/help-completeness.test.js:322`. **S**

## Risks

* **The default is unresolved evidence.** `research/lldp-default-state.md` records Cisco's guides saying
  disabled, field reports saying enabled, and Arista contradicting itself. No step here flips a default:
  every device still announces, `lldp run` is accepted and a no-op when already on, and `docs/CLI.md`
  states the model's choice. A per-device default is a separate plan gated on one factory-default capture.
* **No capability token.** `test/capability-vocabulary.test.js:88` requires every advertised token to have a
  reader, and a token no spec declares would be false for the whole catalogue; gating on the console is the
  smaller, truthful edit.
* **Instant vs. aged.** Turning LLDP off must not empty a neighbour table; deleting a row is the answer for
  a dead peer, not for a peer that is still up and merely unheard.
* **Silent save loss.** A setting missing from `serialize()`, `hydrate()` and the running-config printer
  disappears on reload - the bug #1405 and #1321 fixed once already.
* **Counters break determinism if saved.** `show lldp traffic` stays in the runtime state, beside the flow
  counters, or two identical runs stop being identical (`test/replay-identical.test.js`).
* **The status block is a transcript.** With defaults untouched the four lines must stay byte-identical
  (`test/show-lldp-status.test.js:49-73`); only configured values may change them.

## Test strategy

New `test/lldp-config.test.js`: off/on round-trip through save and reload, transmit-disabled port sends
nothing while its peer's row ages out, timer x multiplier arithmetic, range refusals. Extend
`show-lldp-status` (the `% LLDP is not enabled` line), `lldp-hold-time` (a configured timer moves the expiry
instant), `config-roundtrip`, `running-config-*`, `neighbours-on-load`, `persistence`. Run
`node scripts/run-tests.js --filter=lldp` and, for step 5, `node scripts/check-doc-citations.js`.

## Left out, deliberately

`show lldp neighbors detail` (no primary transcript of the seven-line block exists in `research/`, and
inventing the layout is the opposite of this project's rule); a per-device default off; LLDP-MED, DCBX and
CDP (§5.9's own Absent row); `lldp reinit delay` (nothing initialises on a timer, so it would be a number
with no reader); and any change to how often announcements happen - one per run is the discrete-run model's
premise, not an LLDP setting.

## Issues

Closes none of the nine open (all PRs). It removes the three recorded statements of absence at
`docs/CLI.md:2447`, `engine/cli.js:5917` and `research/lldp-default-state.md`, where the research note
already asks for exactly these changes once the default question is settled - and none of the steps requires
settling it.
