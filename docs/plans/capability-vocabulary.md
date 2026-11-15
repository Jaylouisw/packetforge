# Plan: one capability vocabulary, every token accounted for

Status: forward plan, no code. Closes #1526. Touches `docs/DEVICE_SCHEMA.md`, `engine/device.js`,
`scripts/import-devices.js`, `devices/ruijie/*`, tests. No engine behaviour change is proposed
without its own PR.

## What exists today

`CAPABILITIES` is a single literal array of 15 tokens at `engine/device.js:104-118`, exported
through `engine/index.js:61`. The importer does not keep a copy: `scripts/import-devices.js:20`
imports it, `:85` refuses a category-less target, and `:182-190` sorts an unknown token into
"looks like a typo" (edit distance <= 2, refused) or "kept as declared, so the simulator ignores
it" (warned). `test/import-devices-capabilities.test.js:73-84` asserts importer array === engine
array, so the two cannot drift apart.

Behaviour is read in two ways:

* `hasCap()` / `isL2()` / `isL3()` (`engine/device.js:558-576`), called from `engine/cli.js:187,
  1150, 4380`, `engine/simulator.js:1965, 2023, 3112`, and through the refusal helper
  `_capabilityRefusal()` at `engine/cli.js:288-292` for `dhcp-server` (:588), `l3-forward`
  (:700, :824, :1150, :1376), `nat` (:843, :3173) and `l2-forward` (:949, :956, :965).
* direct `capabilities.indexOf(...)`: `poe-pse`/`poe-pd` (`engine/media.js:1106, 1124`),
  `l2-forward` (`engine/cli.js:3123`), and the `SERVICE_PORTS` table read in
  `engine/flow.js:309-315` for `cli`, `dhcp-server`, `http-server`.

So nine tokens are honoured: `host`, `l2-forward`, `l3-forward`, `cli`, `http-server`,
`dhcp-server`, `nat`, `poe-pse`, `poe-pd`. The catalogue is 2,057 specs; a census run today
finds 21 distinct strings in `capabilities` arrays.

## What is missing or weak, ranked

1. **Six tokens are documented as behaviour and answer for nothing** (#1526): `dhcp-client`,
   `firewall`, `wireless`, `vlan`, `lacp`, `stp` have zero `hasCap()`/`_capabilityRefusal()`/
   `SERVICE_PORTS` readers. VLANs (`engine/vlan.js`, `engine/cli.js:375`), STP (`engine/stp.js`,
   `engine/convergence.js:160`) and LACP (`engine/lag.js`) all run on any `l2-forward` box, and
   `channel-group` is gated on `l2-forward` (`engine/cli.js:965`), not `lacp`. This is no longer
   hypothetical: the six `devices/ruijie/rg-nbs3100-*.json` specs declare `vlan`, `lacp`, `stp`.
2. **Two ghost tokens are branched on that are not in the vocabulary.** `engine/device.js:476`
   reads `hasCap('route') || hasCap('router')`, both permanently false for every spec, so the line
   silently degrades to `!this.isL2()`. Someone meant `isL3()`.
3. **824 declarations sit outside the vocabulary, across 599 files**: `passive-poe` (284),
   `802.3af` (241), `802.3at` (233), `802.3bt` (55), `poe-injector` (10), `wifi-ap` (1). They are
   kept and warned, correctly — but every import run is noisy, and the vocabulary has no place to
   say "this is a power fact, not a behaviour".
4. **`docs/DEVICE_SCHEMA.md:50-95` is wrong in two directions.** It calls the list "the set of
   tokens the simulator actually branches on" (false for the six above), names `midspan` as in use
   while 0 of 2,057 specs declare it, and omits `wifi-ap`, which one does.
5. **Nothing guards the whole catalogue.** The importer warns only on its own runs; a spec added
   by any other route can carry an unknown token, and `test/catalogue-hygiene.test.js` does not
   look at `capabilities`.

## Ordered steps

| # | step | size | closes |
|---|---|---|---|
| 1 | `engine/device.js:476`: `hasCap('route') \|\| hasCap('router')` -> `this.isL3()`; regression in `test/capability-gates.test.js` proving a pure switch stays unscoped-L3-free and an L3 box answers its far-side address | S | (file an issue with the PR) |
| 2 | Split the vocabulary in `engine/device.js`: `CAPABILITIES` (the nine it honours, plus the six pending a decision in step 5) and a new exported `DECLARED_CAPABILITIES` holding `802.3af/at/bt`, `passive-poe`, `poe-injector`, `wifi-ap` (`midspan` too, if it is ever declared — the doc already claims it). Keep `CAPABILITIES` the union for `hasCap()` back-compat; `scripts/import-devices.js` warns only on a token in neither list | S | — |
| 3 | New `test/capability-vocabulary.test.js`: walk `devices/**/*.json`, assert every token is in the union, and assert every token in `CAPABILITIES` is named by at least one reader (grep `engine/` for `hasCap('<t>')`, `_capabilityRefusal('<t>'`, or a `SERVICE_PORTS` key). This is the guard that makes #1526 unable to recur | M | #1526 (half) |
| 4 | `docs/DEVICE_SCHEMA.md`: split the table into "honoured" and "declared, inert", drop the `midspan` claim unless a spec declares it, add `wifi-ap`, and replace "the set of tokens the simulator actually branches on" with what is true | S | — |
| 5 | Per-token decision on the six inert ones, one PR each, cheapest first: `vlan`, `lacp`, `stp` are properties of bridging in this model, so remove them from `CAPABILITIES` and from the six Ruijie specs (1024 of 1030 L2 specs carry no `vlan` token, so gating on it would switch VLANs off for almost the whole catalogue); `firewall` and `wireless` — declare them inert, or gate `access-list` (`engine/cli.js:539`, currently ungated) and note #1517 carries the SVI defect; `dhcp-client` — either wire DHCP DORA to it in `engine/dhcp.js` (no reader today) or drop it | S/M each | #1526 |
| 6 | Census output as a script (`scripts/capability-census.js`) so the next plan quotes numbers instead of re-deriving them by hand | S | — |

Step 5 is where "needs Jay's approval" applies: dropping `firewall`/`wireless`, or wiring
`dhcp-client`, changes what a device may be configured to do, and should not ride on a cleanup PR.

## Risks

* Capability gates refuse *commands*, not loads (`docs/DEVICE_SCHEMA.md:99`), so a tightened gate
  cannot break a saved topology — but a gate added to `access-list` would refuse ACLs on routers
  that legitimately filter.
* `test/capability-gates.test.js:22` selects test fixtures *by capability token* (`withCap`), so a
  removed token must not be one a fixture is chosen by; `vlan`/`lacp`/`stp` are unused there today.
* 599 files carry declarative tokens; bulk edits of `devices/**` belong in their own PR, separate
  from any test that would have to be regenerated.

## Test strategy

`node test/capability-vocabulary.test.js` (new), `test/import-devices-capabilities.test.js`,
`test/capability-gates.test.js`, `test/catalogue-hygiene.test.js`, plus one console transcript per
gate touched in step 5 in the style of `capability-gates.test.js`'s docblock.
