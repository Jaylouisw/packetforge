# Plan: a device that accepts power has one inlet, not one per port

Status: forward plan, no code. Measured on `0af1f392`, 2026-11-19. Closes **no** open issue
directly — it removes the family that produced #2121, #2118, #2111, #2105 (merged) and #2124
(open, and red on a suite this plan repairs). Scope: `engine/media.js:1086-1116` and `:1147`,
`engine/device.js:1433`/`:1651-1658`, `engine/simulator.js:2555-2612`, `web/faceplate.js:630`,
`web/app.js:2202`, `docs/DEVICE_SCHEMA.md:208`, `test/poe.test.js:21`, `test/poe-inference.test.js`,
one new suite, one new audit script. No engine rule that decides a link's state changes here except
step 3, which is called out.

## What exists today

**The PSE side has a flag; the PD side does not.** `derivePortHardware()` records
`poeOutDeclared` (`media.js:1089`) precisely so "the hardware said so" can be told from "the engine
guessed" — the comment at `:1087` says so, and `test/poe-inference.test.js:96` enforces it for
outputs. The returned descriptor has no `poeInDeclared` at all (`grep -rn poeInDeclared` returns
nothing), so nothing downstream can ask the same question about a powered device.

**Inference promotes a device-level claim to every copper port.** `media.js:1104-1107`:
`if (port.poeOut === null && port.poeIn === null && carriesPower)` then
`else if (isPoePd(dev)) port.poeIn = 12.95;`. `isPoePd()` (`:1147`) returns true on any of three
device-wide facts — the `poe-pd` capability, `category` in `wireless|ptp|camera`, or
`/litebeam|nanobeam|powerbeam|unifi|u6|u7|eap|wap|cube|lhg|sxt|mantbox/` against
`model + ' ' + label`. None of them says *which* socket. There is no port cap and no device-shape
gate, so the loop fills the whole RJ45 population.

**What that produces, measured through the engine** (`Topology().addDevice(spec)`, every spec in
`devices/`):

```
PD ports in the catalogue: 1,661 on 649 devices — 251 declared in a spec, 1,410 inferred (85%)
devices with at least one inferred PD port: 448 of 649
devices holding 3 or more PD ports purely from the guess: 99
  ubiquiti/USW-Pro-48   switch  0 PSE, 48 PD → 621.6 W, label "UniFi Pro 48"
  ubiquiti/ECS-48S      switch  0 PSE, 49 PD → 634.6 W
  ubiquiti/UCG-Ultra    router  0 PSE,  5 PD →  64.75 W (6.2 W USB-C box; #2124)
  mikrotik/RB1100Dx4    router  0 PSE, 13 PD → 168.3 W (capability `poe-pd` alone)
  peplink/MAX-BR1-MINI-LTE-E router 0 PSE, 3 PD — the datasheet says "PoE Input Yes" on one WAN port
```

**The guess is load-bearing, and it can darken a router.** `simulator.js:2589` takes
`peerIface.poeIn` as the draw; a draw the budget cannot cover sets `peer.poeUnpowered = true`
(`:2602`), and that flag then drops frames (`:3054`) and refuses connections with
`E_POE: no PoE power available` (`:4106-4109`). A UCG-Ultra asking a 64.75 W PSE for 5 × 12.95 W
is a device that three PRs say receives nothing.

**The only way to say "no" is a value the schema did not document.** At the measurement, six
merged files carried `"poeIn": false` (`devices/ubiquiti/udm-pro-max.json`,
`uxg-{enterprise,fiber,lite,max,pro}.json`) — the shape #2121 and #2118 chose to stop the guess —
while `docs/DEVICE_SCHEMA.md:204` read `poeIn` as "watts this port draws, as a **number**. `true` is
wrong". The practice spread faster than the schema: **35 specs carry it on 274 sockets**
(re-measured on `4f0deb81`, 2026-11-28 — the three non-PoE UniFi switches and the Peplink BR1 IP55,
HD2 Mini and BR2 Pro inlet rows), and the row, now at `:208`, names it. So `false`, `0` and `null`
are three spellings for two meanings ("explicitly not a PD" vs "not stated"), and `null` is the
one the engine reads as "guess me". `numOrNull(false)` (`validation.js:213`) returns `0`, so a
round-trip through validation silently loses the distinction.

**The operator sees the guess as a fact.** `web/faceplate.js:630` titles the port
`PoE in 12.95 W` and `web/app.js:2202` prints `PoE / PD, powered by the cable`, on all 48 ports
of a mains-powered aggregation switch.

**The one suite that exercises the budget uses the device being un-powered.** `test/poe.test.js:21`
sets `const PD = 'UCG-Ultra'`. Run against #2124's branch (`catalogue/1119-0852`):

```
✗ and the PD declares what it draws (false W)
✗ one device was powered (0 W used)
```

That is the coordination defect: the data is being corrected row by row while the test treats the
row as ground truth.

## What is missing or weak, ranked

1. **No record of whether a PD port was declared or guessed** — the asymmetry with
   `poeOutDeclared` is the root of everything below and of the per-row PR chain.
2. **Device-wide claims applied per-port** — 99 devices with three or more PD ports, 1,410 inferred
   ports, including 24 switches and 26 routers.
3. **No vocabulary for "not a powered device"**, so six files invented `poeIn: false` against the
   documented schema and the next correction has no precedent to copy.
4. **Provenance never reaches an operator** — faceplate and detail panel print a guess in the same
   words as a datasheet figure.
5. **No census, no gate** — `scripts/audit-poe-budget.js` counts PSE budgets only; nothing counts PD
   ports, so the 99 are invisible between PRs.

## Ordered steps

| # | step | size | closes |
|---|---|---|---|
| 1 | `poeInDeclared` beside `poeOutDeclared`: set from the spec's interface field (`false` or a number counts as declared), `false` when inferred, carried through saved-port restore (`device.js:1433`, `:1658`). No behaviour change; assert in `test/poe-inference.test.js` that every inferred `poeIn` has the flag `false`. | S | 1 |
| 2 | Sanction the word "no": **the doc half has landed** — `DEVICE_SCHEMA.md:208` now names `false` for a socket that is not a PD. Left is the code half: `numOrNull()` keeps `false` distinguishable from `null`, and a one-off check that all 45 `false` specs still read as non-PDs. | S | 3 |
| 3 | **Changes an answer** — an *inferred* PD claims at most one inlet: the lowest-numbered copper port whose name the class implies, never a port on a device that already declares `poeOut` there. Measured effect 1,410 → ≈448 inferred ports; 99 → 0 devices with ≥3. Declared ports are untouched. | S/M | 2 |
| 4 | The 99, from their own datasheet, ten rows per PR: which socket is the inlet, its class (af 12.95 / at 25.5 / bt 60 / 90), or `false`. Batch by vendor so one reviewer sees one product family. | M | 2 |
| 5 | Repair the suite step 3 and #2124 expose: `test/poe.test.js:21` swaps `UCG-Ultra` for a device whose own file declares `poeIn: 12.95` (`devices/ubiquiti/u6-pro.json`), keeping the L3-and-can-ping property the two-party budget test needs. | S | 1, 5 |
| 6 | `scripts/audit-poe-pd.js`: cohort lines (declared / inferred / ≥3 ports / inferred on a router or switch), `require.main` guarded and exported, printed before and after in every PR of step 4. Not gated. | S | 5 |
| 7 | Say it on the surfaces: `faceplate.js:630` and `app.js:2202` print "assumed" for a port with `poeInDeclared === false`, in the wording already used for a capable-but-uncabled PSE port. | S | 4 |
| 8 | Gate last: `audit-poe-pd.js --strict` into `package.json`'s premerge once step 4 reaches zero inferred-multi. | S | 5 |

## Risks

- **Step 3 changes lab answers.** A UCG-Ultra that used to draw power now does not, so an existing
  topology's `E_POE` can disappear and a PSE's `used` total can fall. Every PR must quote the
  before/after census and name the topologies it changes.
- **`false`, `0`, `null` are already three spellings** and `numOrNull(false)` collapses one of them.
  Step 2 must not turn a deliberate "no" into a silence the inference refills — that would be a
  regression that looks like a fix.
- **Legitimate dual-inlet hardware.** USW-Flex both draws and sources, and its spec declares it;
  step 3 must only ever narrow *inferred* ports, or it will un-power devices whose files are right.
- **The panel has its own copy of the allocation rule** (`web/app.js:2095`), the #1293 drift class:
  step 7 must read the same flag, not a second derivation of it.
- **The 99 are not one decision.** MikroTik's `poe-pd` capability may itself be wrong for
  RB1100Dx4; clearing the port is not the same as clearing the capability.

## Test strategy

New `test/poe-pd-inference.test.js`: a catalogue-wide invariant that no inferred PD port exists on a
device with three or more copper ports, plus fixtures for `false` / `0` / `null` (only the first is
"no"), a restored port keeping its flag, and a two-party case where a mains-powered router plugged
into a 64.75 W PSE stays up. Regression set: `test/poe.test.js`, `test/poe-inference.test.js`
(including `PD_ONLY` at `:104`, which pins EP-R6/ER-10X/ACB-AC as still *accepting* power),
`test/poe-agreement.test.js`, `test/poe-allocation-order.test.js`,
`test/show-power-inline.test.js`, `test/hardware-invariants.test.js`, then `npm test`. Each step
PR quotes `node scripts/audit-poe-pd.js` before and after.

## Issues this would close

None outright. #2124 stays necessary for its two data rows, but stops being red once step 5 lands;
#2105, #2111, #2118 and #2121 are the rows this plan would have prevented. #130 (UDW-PRO) and
#2128 (the UMR's 10 W passthrough) are device requests and are untouched.

## Deliberately left out

`docs/plans/poe-budget-variants.md` owns the PSE budget as a scalar and its conditional variants;
this plan only ever touches the PD's draw, and per-port negotiation (LLDP 802.3at class exchange,
`power inline auto` arbitration) is out of scope for both. The `poe-pse`/`poe-pd` capability split
belongs to `docs/plans/capability-vocabulary.md`. Real per-port wattage for every AP (12.95 is the
802.3af default, and a Wi-Fi 6E AP on 802.3bt draws 25+ W) is a data campaign, not a rule change,
and is not proposed here.
