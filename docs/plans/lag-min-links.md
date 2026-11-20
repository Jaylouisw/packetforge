# Plan: a bundle keeps carrying on one link, and the key already promises a flag it cannot print

Status: forward plan, no code. Measured on `2fb4a9a7`, 2026-11-20, with a two-switch probe lab
(`generic-switch` pair, `channel-group 1 mode active` at both ends, one PC each side). Closes **no**
open issue — the queue holds two device requests (#803 OptiXtrans E6616X, #130 UDW-PRO). Scope:
`engine/lag.js` (the `minLinks` field and one new verdict), `engine/cli.js` (the `channel-group`
door, `_show`'s etherchannel table, the `show ip interface brief` bundle row),
`engine/simulator.js:3704-3718` (the LAG egress), `docs/CLI.md`, `docs/SIMULATION.md`, one new
suite. Steps 3 and 4 change answers two existing suites pin; they are called out below.

## What exists today

**The threshold is parsed, defaulted, and then dropped.** `normalizeLag()` reads `c.minLinks`, floors
it, and falls back to `DEFAULT_MIN_LINKS = 2` (`engine/lag.js:99`, `:156-160`). It is only reached
from `validateLag()` (`engine/lag.js:427`). The console never calls either on the object it writes:
`channel-group` builds `const g = existing || { mode: mode, hashPolicy: 'l2', members: [] }`
(`engine/cli.js:3823`) and stores it (`:3844`). The group a real session holds has no such key —
read back after the lab below:

```
{"mode":"lacp-active","hashPolicy":"l2","members":["Fa0/2","Fa0/3"]}
```

So `minLinks` exists in one function, in one unit test (`test/lag.test.js:34`, "default minLinks is
2") and in no other file in the tree — `grep -rln minLinks` over `examples/`, `catalogue/`,
`devices/`, `server/`, `web/` and `test/` returns that test alone — and in no configuration an
operator can build.

**The key prints a state the table cannot reach.** `ETHERCHANNEL_FLAGS` carries
`M - not in use, minimum links not met` (`engine/cli.js:447`), transcribed from the device's own
legend. Nothing emits it: the bundle cell is `'S' + (live.length ? 'U' : 'D')`
(`engine/cli.js:6939`) — two states, in use or down — and no member letter in the table means "the
group is short of links". The key was copied faithfully and one of its nine letters is decoration.

**One live member is "up", and the traffic agrees.** Measured, two members, then the first one taken
out of service with `interface Fa0/2` / the port-admin verb:

```
1      Po1(SU)         LACP      Fa0/2(D) Fa0/3(P)
  Fa0/2     not bundled (administratively down)
  bundle 1 is running on 1 of 2 members: Fa0/3
a# ping 10.0.0.10
!!!!!   Success rate is 100 percent (5/5)
```

`_lagMemberStates()` (`engine/cli.js:5657`) decides `live` from "can this member carry", and both
the summary (`:6923-6983`) and the bundle row in `show ip interface brief`
(`engine/cli.js:6273`, `live.length ? 'up' : 'down'`) read that one predicate. The data plane does
the same: `live = lagLib.eligibleMembers(members, canCarry)` (`engine/simulator.js:3704`) and the
frame is hashed across whatever is left. The `lag` event's `degraded` flag compares against
*capacity*, not a threshold — `live.length < Math.min(members.length, MAX_ACTIVE_LINKS)`
(`engine/simulator.js:3716`), i.e. "not eight wide", which is a different claim.

**Nothing can set it, and there is no interface to set it on.** Measured at the console:

```
s1(config)# port-channel 1 min-links 3
% Unrecognized command: port-channel 1 min-links 3
s1(config)# interface Port-channel1
% Unrecognized command: interface Port-channel1
s1# show running-config
  channel-group 1 mode active
  channel-group 1 mode active
```

The vendor's grammar is `port-channel min-links <n>` in the *bundle's* interface mode; this console
has no `interface Port-channelN` mode (the show-side refusal at `engine/cli.js:7232-7240` says so in
words). `show running-config` therefore has no line to print and a save/reload round-trip cannot
lose what was never stored.

**The docs already name the hole, with a stale citation.** `docs/SIMULATION.md:151` marks
`minLinks` **Approximate** ("normalised and validated but never read at runtime"), and `:606` lists
it among fields that are "decoration" — citing `engine/lag.js:90`, where the constant no longer
lives (`:99`). `docs/CLI.md:2447` shows the `running on 1 of 2 members` row as intended output and
never mentions a minimum.

## What is missing or weak, ranked

1. **No configuration surface.** No verb, no `running-config` line, no round-trip; the only way to
   set a threshold is to hand-edit a lab document.
2. **The number never reaches the model.** The console writes a group literal that has no
   `minLinks`, so a document that carries one is normalised only if some other path rebuilds it, and
   the default `2` cannot be told from "unset".
3. **No verdict, so the data plane and the view disagree with the key.** A one-link bundle forwards
   at full rate while the legend above it advertises `M`.
4. **Two views would have to change together.** The summary cell and the `show ip interface brief`
   row both derive state from `live.length` in two places; a threshold read in one and not the other
   is the #1293 drift class.
5. **The default is invented.** `DEFAULT_MIN_LINKS = 2` is PacketForge's number, not the vendor's
   (`port-channel min-links` defaults to 1 on IOS), and `test/lag.test.js:34` pins it. If a threshold
   of 2 is applied to every group by default, every one-member group under construction becomes
   "down" — a behaviour change wearing a bug fix's clothes.

## Ordered steps

| # | step | size | closes |
|---|---|---|---|
| 1 | Research capture: the vendor's `port-channel min-links` semantics — default value, range, whether the bundle goes down or merely stops forwarding, the flag the Port-channel cell carries when the minimum is not met, and whether members stay `P`. One `research/lag-min-links.md`, sources only, no code. | S | 5 |
| 2 | Put the number on the thing the console stores: `minLinks` survives `channel-group` (a new group is built through `lagLib.normalizeLag()` instead of the literal at `engine/cli.js:3823`), absent means "no threshold" rather than `2`, and the default constant is whatever step 1 measured — flagged **needs Jay's approval** if it is 1, because `test/lag.test.js:34` pins the 2 and would
change meaning. | S | 2, 5 |
| 3 | One predicate read everywhere: `lagLib.bundleState(cfg, live)` in `engine/lag.js` returning `{ met, minLinks }`, consulted by `_lagMemberStates()` so the summary cell, the member letters' context and the `show ip interface brief` row cannot disagree. This is the step that changes two pinned answers: `test/brief-port-channel-row.test.js:16` ("one live member is enough for `up up`") gains "unless the group states a minimum", and `test/lag-member-down.test.js:105` keeps the `running on 1 of 2` sentence only when no threshold is configured. | S | 3, 4 |
| 4 | The console verb: `port-channel <id> min-links <n>` in config mode plus its `no` form, validated against the range step 1 measured, refused with the group's name when the group does not exist, and printed by `show running-config` on the group's existing line only when set. Deviation from IOS (no `interface Port-channelN` mode) stated in the receipt and in `docs/CLI.md` — **needs Jay's approval** on the spelling. | M | 1 |
| 5 | The summary tells the truth: `PoN(SM)` — the `M` the key already prints — with a sentence naming the numbers (`bundle 1 is down: 1 of 2 members carrying, min-links 2`), and the data plane stops hashing onto a group whose minimum is not met (`engine/simulator.js:3704`, one `lag` event with `minLinksNotMet: true` so a ping's "why" can cite it). | M | 3 |
| 6 | Bookkeeping: `docs/CLI.md` etherchannel section gains the verb and the `(SM)` row; `docs/SIMULATION.md:151` and `:606` lose the Approximate/decoration entries and the `:90` citation is corrected to wherever the constant ends up. | S | 5 |

## Risks

- **Step 3 changes lab answers, and silence looks like a fix.** A bundle that used to carry on one
  link will drop frames once a threshold is set. Every PR must quote the before/after `show
  etherchannel summary` and name the labs whose ping stops.
- **A default of 2 breaks works-in-progress.** A group is built one port at a time
  (`engine/cli.js:3866-3871` deliberately suppresses `E_LAG_TOO_FEW` for exactly this reason); a
  default threshold would report every half-typed bundle as down. Absent must mean unset, and step 1
  must settle whether the vendor's 1 is modelled as unset or as an explicit 1.
- **Stand-alone members are not a shortfall.** `memberSuspension()` and the `(I)` letter describe a
  port that left the bundle and still carries as a single link. The minimum-links verdict must not
  double-count them, and must not turn a two-member bundle of stand-alone ports into "two links
  dropped" — the sentence at `engine/cli.js:6989` gets that right today and step 5 must not lose it.
- **Two copies of the state.** The brief row (`:6273`) and the summary cell (`:6939`) both compute
  `live.length`; if step 3 patches only the summary the two views disagree, which is the defect this
  plan exists to remove.
- **`hashPolicy` has the same disease** — `engine/cli.js:3823` defaults it to `l2` while
  `engine/lag.js:98` defaults to `l3l4`, and the console never normalises it either. Out of scope
  here, but step 2's `normalizeLag()` call will silently adopt `l3l4` for new groups; the PR must
  say so or pass the console's default explicitly.

## Test strategy

New `test/lag-min-links.test.js`, built like `test/lacp-one-sided-group.test.js`: a two-switch lab
with two members; assertions for (a) a group with no threshold still reads `(SU)` and pings 5/5 with
one member down — the behaviour pinned today; (b) `port-channel 1 min-links 2` then one member down
gives `Po1(SM)`, `down down` in the brief, and a ping that fails with a cited reason; (c) `no
port-channel 1 min-links` restores (a) without a reload; (d) the line appears in `show running-config`
only when set and survives a save/restore; (e) a range refusal and a missing-group refusal; (f) two
stand-alone members still cross traffic. Regression set: `test/lag.test.js`,
`test/etherchannel-summary-layout.test.js` (the legend is character-for-character and must not move),
`test/lag-member-down.test.js`, `test/brief-port-channel-row.test.js`,
`test/lacp-one-sided-group.test.js`, `test/lacp-passive-both-ends.test.js`,
`test/etherchannel-member-limit.test.js`, then `npm test`. Docs steps run
`node scripts/check-doc-citations.js`.

## Issues this would close

None. The queue is two device requests and neither is about LAG. This plan removes the field
`docs/SIMULATION.md` lists as decoration and makes the `M` letter in a copied legend reachable.

## Deliberately left out

`interface Port-channelN` as a configurable interface — addresses, `switchport`, STP cost on the
bundle — is a larger surface with its own open spells (`research/port-channel-show-interfaces.md`,
`research/mac-table-port-channel-name.md`, `research/port-channel-path-cost.md`); this plan only
needs the *name* to exist, not the mode. LACPDU on the wire, `lacp system-priority` and per-port
priority are `docs/SIMULATION.md`'s Approximate row and stay there. `lacp fast-rate`/`slow-rate`
timers, errdisable recovery for `min-links`, and `max-bundle` (the hot-standby cap that
`research/etherchannel-member-limit.md` shows is configurable on 3850) are related knobs and none is
proposed here.
