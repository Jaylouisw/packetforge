# Plan: the BGP decision process has three inputs and no way to type them

Status: forward plan. Measured on `4c051c04`, 2026-11-24. Open issues: **zero** — this plan closes nothing;
it exists because `docs/BGP-POLICY.md` (1,176 lines) specifies a policy layer in RFC-level detail and the
engine implements none of it. Scope: `engine/bgp.js` (ingest/egress), `engine/simulator.js` (`computeBgp`),
`engine/cli.js` (`_bgp`, a new `_routeMap`, `_help`), `docs/CLI.md`, `docs/SIMULATION.md`, new suites.
No step needs Jay's approval: every command below already exists on a real router, and the spec is his.

## What exists today

**The comparator is complete and unused.** `comparePaths()` (`engine/bgp.js:526`) walks weight →
localPreference → AS-path length → origin → MED (gated by `medComparable()`, `:503`) → eBGP-over-iBGP → IGP
cost → router ID, with `bestPath()` (`:603`) as the elimination pipeline. Eleven suites and 1,853 lines
(`test/bgp*.js`) pin it.

**Nothing can produce its inputs.** Every path is built with constants: `localPreference:
bgpLib.DEFAULT_LOCAL_PREF, med: 0, weight: 0` (`engine/simulator.js:1972`). `advertise()`
(`engine/bgp.js:626`) copies `localPreference`/`med` onto every output, including `type: 'ebgp'`.
`grep -rn "community\|routeMaps\|next-hop-self\|deniedIn" engine/` returns only URLs and prose: there is no
route-map data model, no `set`/`match` verb, no community attribute, no counters. `medComparable()` is the
only policy-ish logic, and `always-compare-med` is documented as unmodelled (`engine/bgp.js:20`).

**The console prints placeholders.** `show ip bgp` hardcodes `metric: '0'` (`engine/cli.js:6116`),
`locPrf:` 100-or-blank (`:6127`) and `weight: '0'` (`:6128`) regardless of the path object. The LocPrf
blank/100 split is deliberate and correct; the two `0`s are not a value the engine ever read.

**The console can only say five things about BGP.** `_bgp()` (`engine/cli.js:3366`) accepts `router bgp`,
`bgp router-id`, `neighbor <ip> remote-as` and nothing else, ending in the `% Usage:` line at `:3413`.

**Known compliance bug, not just a gap.** `advertise()` emits `localPreference` to eBGP peers
(`engine/bgp.js:657`), which RFC 4271 §5.1.5 forbids; `test/bgp.test.js:340-341` asserts that behaviour, so
the suite currently protects the defect.

## Ranked gaps

1. **No policy input surface.** weight / LP / MED can never be non-default — the whole decision table is
   decoration. (`:1972`)
2. **LOCAL_PREF and MED cross the eBGP boundary** in the model (`bgp.js:657`), so a path the spec says is
   sanitised outranks one it should not.
3. **No communities** (RFC 1997), so `no-export`/`no-advertise` cannot be expressed at all.
4. **No `next-hop-self`**, which is the standard fix for the iBGP relay black hole already noted at
   `simulator.js:1999`.
5. **No visibility into policy drops** — nothing counts what a route map denied.

## Ordered steps

Each is one PR by one worker, in order; every earlier step leaves the tree green.

1. **S — LOCAL_PREF/MED hygiene on the wire.** Add `localPrefSource` (`peer|policy|default|ignored`) and an
   `ingressPath()` helper to `bgp.js`; strip `localPreference`/`med` from eBGP output in `advertise()`
   (`:626`) and in the UPDATE loop (`simulator.js:1990-2010`). Flip `test/bgp.test.js:340-344` to
   `null` and move the "carried per route" check to an iBGP peer. Closes the §11.8 assertion table.
2. **S — `bgp default local-preference <n>` and `bgp always-compare-med`** in `_bgp()` + `no` forms +
   range errors, consumed by step 1's baseline and `medComparable()`.
3. **M — Route-map data model and parser.** `dev.config.routeMaps` in §8.1 shape; `route-map <name>
   permit|deny [<seq>]`, `no route-map`, auto-seq `previous+10`; sticky `this._routeMap` clearing on
   `exit`/`end`; `show route-map [<name>]`. No `match`/`set` yet — an empty map is a valid permit.
4. **M — `set` verbs and the legality matrix.** `local-preference`, `metric`, `metric none`,
   `community [additive|none]`, `weight`, `origin`, `next-hop` — with the three config-time refusals from
   §8.3 (`weight` outbound, `next-hop` inbound, bare `set` with no map selected).
5. **M — Communities as a path attribute.** `parseCommunity()` + `communities: []` on every path object;
   `match community <c>... [exact]`; `no-export` suppression in the egress path (§5.4).
6. **L — Bind and apply.** `neighbor <ip> route-map <name> in|out`, `no neighbor ...`, the §2.2 note line
   when an outbound map carries `set local-preference`; apply ingress after sanitise and egress before
   attribute rewrite inside `computeBgp()`; add `deniedIn`/`deniedOut` to the per-speaker stats.
7. **M — Next hop.** `neighbor <ip> next-hop-self` and `no`; call `advertise()` from the UPDATE loop
   instead of deriving AS path/next hop inline (`simulator.js:2003-2009`), so §7.4's rewrite order lives in
   one place.
8. **M — Make the table honest.** Feed `metric`/`locPrf`/`weight`/`path` from the path object instead of
   `'0'`/`'0'`/`'100'` (`cli.js:6116-6128`); add `show ip bgp neighbors <ip>
   [advertised-routes|received-routes]`; print denial counts in `show ip bgp`.
9. **S — Docs.** `docs/CLI.md` grammar rows, `docs/SIMULATION.md` policy phase description, flip
   `docs/BGP-POLICY.md`'s status from "not yet implemented", `_help()` additions (§9.4).

## Risks

- **Line drift.** The spec's anchors (`cli.js:2009-2027`, `:8434`) are stale; every one must be re-found by
  symbol, not number. The BGP config branch is now `:2017-2027` and `_help()` is `:8459`.
- **Order matters.** Step 6 without step 1 leaks LOCAL_PREF to eBGP peers via a route map; steps 3-5 are
  harmless alone.
- **`set metric none` is a simulator extension** (required by RFC 4271 §5.1.4, absent from IOS). It is the
  one line here that is not copied from a real box; keep the help text saying so.
- **Regression surface is wide.** `bgp-wire.test.js` is all-eBGP and must pass untouched — treat it as the
  gate that the policy layer did not change plain BGP.

## Test strategy

One new suite per step (`test/bgp-route-map.test.js`, `test/bgp-communities.test.js`,
`test/bgp-localpref-egress.test.js`, `test/bgp-policy-bind.test.js`), modelled on `bgp-med-neighbour-as.test.js`
(181 lines, two-router lab helper). Pin each §11 assertion with its rule ID in the comment, the house style
(`test/bgp-locprf-column.test.js:2-11`). Full `npm test` before merge; `npm run syntax` for every touched
file.

## Intentionally out of scope

Route reflection (RFC 4456), confederations (RFC 5065), large communities (RFC 8092),
`match ip address <acl>`, `allowas-in`, route damping — all recorded in `docs/BGP-POLICY.md` §12 and none
of them is needed for steps 1-9. `docs/plans/bgp-show-views.md` is the neighbouring plan about `show ip bgp`
argument handling; it does not overlap these rows.
