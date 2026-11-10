# BGP Path-Attribute Policy

**Status:** design specification — not yet implemented.

> **The session model this sits on is now a walk, not an assumption.** Until recently
> `computeBgp()` declared a session established when two routers each had a `neighbor` line
> for the other, and silently `continue`d past every mismatch. `engine/bgp.js` had carried the
> RFC 4271 state machine the whole time with nothing driving it. `establishSession()` now
> walks it — idle → connect → opensent → openconfirm → established — and stops where the
> network stops, reporting the state it died in (`connect` means TCP never opened, which is a
> different fault from an OPEN that was rejected) plus a code:
>
> | Code | Means |
> |---|---|
> | `E_PEER_NOT_ON_SUBNET` | the neighbour address has no next hop: BGP rides TCP, TCP needs one |
> | `E_PEER_NOT_FOUND` | no speaker in the topology holds that address |
> | `E_PEER_NOT_CONFIGURED` | the peer has no `neighbor` line pointing back at us |
> | `E_REMOTE_AS_MISMATCH` | the two ends disagree about who the peer is |
> | `E_IFACE_DOWN` | the address is configured and the port is down — the distinction that matters, because a shut interface keeps its address |
> | `E_NO_ROUTE_TO_PEER` / `E_NO_SOURCE_IP` | the peer is unreachable, or there is nothing to source from |
> | `E_POE` | the box that would open the session was never powered |
>
> A refused session installs no routes, which is the point: "the config looks right" and
> "the prefixes moved" are now different statements. `show ip bgp summary` reads the real
> per-neighbour state.
>
> **Not yet:** reachability is a route plus an up egress on each side. ACLs on *intermediate*
> hops are not consulted, so a session this calls reachable can still be dropped in the data
> path. That is the next increment, and until it lands the verdict is a floor, not a promise.
**Scope:** the policy layer that sits on top of the existing BGP-4 session model
(`engine/bgp.js`, `engine/simulator.js` `computeBgp()`, `engine/cli.js` `_bgp()`).
**Audience:** whoever implements it. Every rule below names the RFC section it
comes from, the function it belongs in, and the assertion that proves it.

This document specifies, exactly:

1. `LOCAL_PREF` — iBGP-only, default 100, first attribute tiebreaker, and what
   happens when it turns up on an eBGP session.
2. `MED` / `MULTI_EXIT_DISC` — default 0, compared only between paths from the
   same neighbouring AS, `always-compare-med` off by default.
3. Communities — standard `AS:VAL`, `no-export`, `no-advertise`, and the exact
   rule for each.
4. AS-path loop prevention, including why a route is never advertised back to
   the peer it came from.
5. Next-hop handling — iBGP preserves, eBGP rewrites, `next-hop-self` overrides.
6. The decision-process tiebreaker table in the order real BGP uses.
7. The CLI grammar additions, in the parser style of `engine/cli.js`, plus the
   table of assertions the implementation must satisfy.

Notation: **MUST** / **MUST NOT** are copied from the RFCs and are normative for
this simulator. `% foo` means a CLI error line. `MAY` means "out of scope here,
recorded so nobody re-invents it differently later".

---

## 1. What exists today, and the seams this design uses

`engine/bgp.js` is a pure-logic module: no timers, no clocks, no I/O, inputs
never mutated. `comparePaths()` already walks most of RFC 4271's decision
process and `advertise()` already models export-side rewriting. The policy layer
must extend those two functions rather than add a parallel universe.

The anchors. Line numbers in `bgp.js` are stable because that file is pure logic nobody has
needed to move; the ones in `cli.js` and `simulator.js` are **not**, and went stale when the CLI grew.
Each row therefore names the symbol first and gives a line only as a hint — `grep -n '<symbol>'`
is the citation that survives a refactor.

| Anchor | Today | This design changes it to |
|---|---|---|
| `bgp.js` `DEFAULT_LOCAL_PREF` / `DEFAULT_WEIGHT` / `DEFAULT_MED` | `DEFAULT_LOCAL_PREF = 100`, `DEFAULT_WEIGHT = 0`, `DEFAULT_MED = 0` | keep; add `MED_MAX`, `LOCAL_PREF_MAX`, `WEIGHT_MAX`, `WELL_KNOWN_COMMUNITIES` |
| `bgp.js` `comparePaths(a, b)` (near the top of the decision section) | 8 steps, MED compared unconditionally (declared simplification in the file header comment) | 9 steps; MED only within a neighbouring AS; optional `opts` third argument; new peer-address step |
| `bgp.js` `compareForBest` / `bestPath` | sort with `comparePaths`, then router-id, then prefix | RFC 4271 §9.1.2.2 *elimination pipeline* (a sortable comparator cannot express the MED rule — see §4.5) |
| `bgp.js` `advertise(routes, opts)` | prepends AS on eBGP, sets next hop, copies `localPreference` and `med` unconditionally | strip `LOCAL_PREF` on eBGP, apply the MED non-transitivity rule, apply community suppression, honour `nextHopSelf` |
| `bgp.js` `pathIsLoopFree` | correct already (AS_SET members included) | keep, no change |
| `Simulator.computeBgp()` — the advertisement loop inside it | Re-derives the AS path inline rather than calling `advertise()`: `asPath = adj.type === 'ebgp' ? [a.as].concat(e.asPath) : e.asPath.slice()`, and the next hop on the same pattern: `nextHop = adj.type === 'ebgp' ? adj.localIp : (e.nextHop or adj.localIp)`. Reachability is checked per peer in `_bgpReachable()` | call `advertise()`/`applyRouteMap()` instead of re-deriving AS path and next hop; add iBGP→iBGP suppression (§6.3) |
| `CliSession._configMode()` — the BGP branches | `router bgp` / `no router bgp` / `neighbor` / `bgp` | add `route-map`, `match`, `set` branches |
| `CliSession._bgp(tokens)` | `as`, `router-id`, `<ip> remote-as` | add `always-compare-med`, `default local-preference`, `<ip> route-map`, `<ip> next-hop-self` |
| `this._dnsZone` (in `CliSession`) | sticky "current zone" context, no new prompt mode | same pattern for the current route-map (§9.2) |
| `CliSession._help()` | command list | add the new lines |

Design invariants that must survive the change, because every existing test
relies on them:

- `comparePaths()` and `bestPath()` never mutate their arguments.
- Missing fields take documented defaults so two sparse paths still compare
  deterministically.
- No clocks and no randomness anywhere in `bgp.js`. (This is why "oldest route"
  is not in the tiebreaker table — §4.2.)
- One session per peer, IPv4 unicast only, no peer groups, no confederations,
  no route reflectors. Policy must not introduce any of those.

---

## 2. `LOCAL_PREF`

`LOCAL_PREF` is the degree of preference a router assigns to a route *inside its
own AS*. It is a 4-octet unsigned integer; higher wins.

### 2.1 Rules

| # | Rule | Source |
|---|---|---|
| LP-1 | Default is **100** (`DEFAULT_LOCAL_PREF`), used when the attribute is absent. | RFC 4271 §9.1.1 (degree of preference), §5.1.5 ("higher degree of preference MUST be preferred") |
| LP-2 | For a route learned from an **internal** peer, `LOCAL_PREF` *is* the degree of preference: the received value is used as-is. | RFC 4271 §9.1.1, first paragraph |
| LP-3 | For a route learned from an **external** peer, the degree of preference is **computed from local policy** (`set local-preference` in an inbound route-map), and that computed value is what gets carried in iBGP readvertisements. | RFC 4271 §9.1.1, second paragraph ("If the route is learned from an external peer, then the local BGP speaker computes the degree of preference based on preconfigured policy information … the return value MUST be used as the LOCAL_PREF value in any IBGP readvertisement") |
| LP-4 | `LOCAL_PREF` is **never encoded** in an UPDATE sent to an external peer. The encoder must omit it; the value must not leak through a third-party field or a route-map. | RFC 4271 §5.1.5 ("A BGP speaker MUST NOT include this attribute in UPDATE messages it sends to external peers, except in the case of BGP Confederations") |
| LP-5 | `LOCAL_PREF` **received** from an external peer is **ignored** — the route takes the default 100 (or the value the inbound policy computes), and the event is counted. | RFC 4271 §5.1.5 ("If it is contained in an UPDATE message that is received from an external peer, then this attribute MUST be ignored by the receiving speaker") |
| LP-6 | Locally originated routes take `bgp default local-preference` if configured, otherwise 100. | RFC 4271 §9.1.1 (policy is a local matter) |
| LP-7 | Valid range 0..4294967295. Out of range is a CLI error, never a clamp. | RFC 4271 §5.1.5 attribute is 4 octets |

### 2.2 Why LP-5 needs code, not just a comment

Three different things can be meant by "ignore it on eBGP", and they must be
implemented in three places, or the attribute will leak:

1. **Ingress (the wire), before policy runs.** A received eBGP path carrying a
   `LOCAL_PREF` must be sanitised before anything else sees it. This happens
   *before* the inbound route-map, precisely so that step 2 below can still
   write a policy value:

   ```js
   // bgp.ingressPath(path, sessionType) -- returns a copy, never the input
   // RFC 4271 5.1.5: LOCAL_PREF received from an external peer MUST be ignored.
   if (sessionType === 'ebgp') {
     out.localPreference = DEFAULT_LOCAL_PREF;
     out.localPrefSource = 'ignored';   // the wire value is gone, not remembered
   } else {
     out.localPrefSource = 'peer';
   }
   ```

   `localPrefSource` is one of `'peer' | 'policy' | 'default' | 'ignored'`
   and exists so `show ip bgp` and the tests can tell "100 because that is the
   default" from "999 thrown away because it arrived over eBGP". Once the
   inbound route-map sets a value, `localPrefSource` becomes `'policy'` — the
   sanitised value is the baseline, not the final answer.

2. **Ingress (the CLI).** `set local-preference` inside an inbound route-map on
   an eBGP neighbour is **legal and honoured** — that is exactly the "compute
   the degree of preference from policy" path in RFC 4271 §9.1.1, and it is
   what operators actually configure. `show ip bgp` marks such a path
   `localPrefSource: 'policy'`.

3. **Egress (the CLI).** A route-map bound **out** to an eBGP neighbour that
   sets `local-preference` is accepted (a real router does not reject it) but
   the value is **not encoded**; `advertise()` returns `localPreference: null`
   for `type: 'ebgp'`. So that the operator is not lied to, the bind command
   emits one extra line after its success line:

   ```
   R1(config)# neighbor 10.0.12.2 route-map EXPORT out
   BGP neighbor 10.0.12.2 route-map EXPORT out
   % note: local-preference is not advertised to external peers (RFC 4271 5.1.5)
   ```

   The note is emitted only when the bound map actually contains a
   `set local-preference`, and only for a neighbour whose `remoteAs` differs
   from the local AS.

4. **Belt and braces.** Even if a caller bypasses `advertise()`, the UPDATE
   builder (`simulator.js`, the loop at line 509) must strip `localPreference`
   for `adj.type === 'ebgp'` in the same place it prepends the AS number.

Net effect that must be observable end to end: a path from an eBGP peer with
`LOCAL_PREF 999` and a path from an iBGP peer with `LOCAL_PREF 100` are compared
as `100` vs `100` — the iBGP path is not beaten by a number that should never
have crossed the AS boundary.

### 2.3 Where it sits in the decision

`LOCAL_PREF` is compared **first, before AS-path length** — position 2 in the
table in §4.1, immediately after the router-local `weight` knob (which is not
an on-the-wire attribute at all). In strict RFC terms it is not a *tiebreaker*:
for iBGP-learned routes `LOCAL_PREF` **is** the degree of preference computed in
Phase 1 (RFC 4271 §9.1.1), and Phase 2 simply keeps "the highest degree of
preference" (§9.1.2). The tie-breaking list of §9.1.2.2 starts at AS-path
length. This document keeps the conventional framing ("LOCAL_PREF is the first
tiebreaker") because that is how the CLI user thinks, but the implementation
must not mis-describe it: steps 1 and 2 in §4.1 are *preference*, steps 3-9 are
*tie-breaking*.

---

## 3. `MED` / `MULTI_EXIT_DISC`

4-octet unsigned, lower wins, default 0. It is an **optional non-transitive**
attribute whose only legitimate job is to tell one neighbouring AS which of
several entry points into *our* AS to use.

### 3.1 Rules

| # | Rule | Source |
|---|---|---|
| MED-1 | Lower `MED` wins. Range 0..4294967295. | RFC 4271 §5.1.4 ("All other factors being equal, the exit point with the lower metric SHOULD be preferred") |
| MED-2 | **Absent MED = 0.** There is no "infinite" and no "missing beats zero" behaviour. | RFC 4271 §9.1.2.2(c) ("If route n has no MULTI_EXIT_DISC attribute, the function returns the lowest possible MULTI_EXIT_DISC value (i.e., 0)"); RFC 4451 §3.2 records why this had to be pinned down |
| MED-3 | MED is compared **only between paths learned from the same neighbouring AS**. Paths from different neighbouring ASes tie at this step and fall through to "eBGP over iBGP". | RFC 4271 §9.1.2.2(c) ("MULTI_EXIT_DISC is only comparable between routes learned from the same neighboring AS") |
| MED-4 | The neighbouring AS is the AS the route *entered* our AS from, not the iBGP peer that relayed it. For a path learned over iBGP whose AS_PATH is non-empty, that is the leftmost AS of the AS_PATH; for an iBGP path that we or the relaying speaker originated (empty AS_PATH, or an AS_PATH beginning with an AS_SET), it is the **local** AS. | RFC 4271 §9.1.2.2(c), `neighborAS()` definition |
| MED-5 | `bgp always-compare-med` (default **off**) removes the same-AS restriction and compares MED across neighbouring ASes. | RFC 4451 §3.3 (implementations provide it; operators should be wary of the side effects) |
| MED-6 | MED is **not** propagated to another neighbouring AS. A route learned from AS 65010 and advertised to AS 65002 must not carry the MED it inherited from 65010. | RFC 4271 §5.1.4 ("The MULTI_EXIT_DISC attribute received from a neighboring AS MUST NOT be propagated to other neighboring ASes") |
| MED-7 | MED **may** be carried over iBGP, and this simulator does carry it (so an iBGP speaker can still make the same choice its border router made). | RFC 4271 §5.1.4 ("If received over EBGP, the MULTI_EXIT_DISC attribute MAY be propagated over IBGP") |
| MED-8 | Local configuration must be able to **remove** a MED from a route, and removal happens before Phase 1/2. Verb: `set metric none`. | RFC 4271 §5.1.4 ("A BGP speaker MUST implement a mechanism (based on local configuration) that allows the MULTI_EXIT_DISC attribute to be removed from a route … prior to determining the degree of preference") |
| MED-9 | Policy-set MED (`set metric <n>`) is a *new* advertisement, not a propagation, and may be sent to an eBGP peer. That is the entire point of the attribute. | RFC 4271 §5.1.4, §9.1.2.2(c) |

### 3.2 Representation: `med` plus `medSource`

`null` means **absent**; `0` means present-with-value-0. They compare the same
(MED-2) but are encoded differently, and the difference is what MED-6 keys on.

`medSource` is `'peer' | 'policy' | 'none'`:

```
egress(path, adj):
  if adj.type === 'ebgp' and path.medSource === 'peer':   med = null   // MED-6
  if adj.type === 'ebgp' and path.medSource === 'policy': med = value  // MED-9
  if adj.type === 'ibgp':                                 med = value   // MED-7
```

A route-map with `set metric 400` applies `med = 400, medSource = 'policy'`
after the strip rule, so policy always wins over inheritance. `set metric none`
applies `med = null, medSource = 'none'`.

### 3.3 Computing the neighbouring AS (`neighborAsOf`)

```js
function neighborAsOf(p, localAs) {
  // RFC 4271 9.1.2.2(c): "the neighbor AS from which the route was received".
  if (pathRank(p) === 0) {                 // eBGP: by 5.1.2(b) the peer
    const as = parseAs(p.peerAs);
    return as !== null ? as : firstAs(p.asPath);
  }
  if (asPathLength(p.asPath) === 0) return parseAs(localAs);  // originated here
  const first = p.asPath[0];
  if (Array.isArray(first) || (isObject(first) && Array.isArray(first.asns))) {
    // AS_SET-leading: only an aggregate has this shape, and 9.1.2.2(c) says
    // an aggregate that begins with an AS_SET counts as the local AS.
    return parseAs(localAs);
  }
  return parseAs(asSegments(p.asPath)[0]);  // where it entered the AS
}
```

Two consequences worth testing explicitly, because they are the ones people get
wrong:

- Two iBGP paths relayed by the *same* border router but entering the AS from
  *different* external ASes have **different** neighbour ASes → their MEDs are
  not compared (MED-3/MED-4).
- Two iBGP paths with empty AS_PATH (both originated inside the AS) have
  `neighborAsOf === localAs` → their MEDs **are** compared with each other.

### 3.4 The number of paths changes the answer — and that is not a bug

RFC 4271 §9.1.2.2(c) is written as set elimination, not as a comparator:

```
for m = all routes still under consideration
    for n = all routes still under consideration
        if (neighborAS(m) == neighborAS(n)) and (MED(n) < MED(m))
            remove route m from consideration
```

A two-argument `comparePaths()` cannot express this. Given `a` (AS1, MED 10),
`b` (AS2, MED 5), `c` (AS1, MED 20): `a` vs `b` ties, `b` vs `c` ties, `a` vs
`c` says `a` wins — a non-transitive order, so `Array.prototype.sort` produces
an order-dependent winner. The existing `bestPath()` sorts, so this is a real
defect waiting to happen the moment MED scoping lands.

**Therefore:** `bestPath()` is re-specified in §4.5 as the RFC's elimination
pipeline, and `comparePaths()` keeps MED as a *pairwise* step that is only
meaningful (a) between two paths, or (b) after elimination. The document's
assertion table tests `bestPath()` over all input permutations, which is the
only way to catch this class of bug.

---

## 4. The decision process, as specified

### 4.1 Tiebreaker table (the order this simulator implements)

| # | Step | Direction | Default | RFC 4271 | Notes |
|---|---|---|---|---|---|
| 1 | `weight` | higher wins | 0 | — (not in RFC 4271) | Router-local, never on the wire. Kept because `comparePaths()` already implements it and the existing tests depend on it (`test/bgp.test.js:388-396`). |
| 2 | `LOCAL_PREF` | higher wins | 100 | §9.1.1 + §9.1.2 + §5.1.5 | **First attribute tiebreaker, before AS-path length.** For iBGP this is the Phase-1 degree of preference, not a §9.1.2.2 tie-break (§2.3). |
| 3 | locally originated | wins | — | §5.1.2(b) (originated routes carry an empty AS_PATH to iBGP) | Vendor convention, implemented via `isLocalPath()` (`bgp.js:343-350`). Strictly it is subsumed by step 4 (length 0), so it can only matter against another zero-length path. |
| 4 | AS_PATH length | shorter wins | 0 | §9.1.2.2(a) | **An AS_SET counts as 1 hop regardless of size.** |
| 5 | `ORIGIN` | lower wins | 2 (`INCOMPLETE`) | §9.1.2.2(b) | `IGP(0) < EGP(1) < INCOMPLETE(2)`, `BGP_ORIGIN`. |
| 6 | `MED` | lower wins | 0 | §9.1.2.2(c) | **Only within one neighbouring AS** unless `always-compare-med`. Absent = 0. |
| 7 | eBGP over iBGP | eBGP wins | — | §9.1.2.2(d) | |
| — | *(interior cost to NEXT_HOP — skipped, §4.2)* | | | §9.1.2.2(e) | |
| 8 | lowest BGP Identifier | lower wins | sort last if absent | §9.1.2.2(f) | The peer's `router-id`. |
| 9 | lowest neighbour address | lower wins | sort last if absent | §9.1.2.2(g) | The peer address the route was received from. New step — `comparePaths()` stops at router-id today. |

After step 9 a **simulator-only** guard breaks what is left: lowest prefix
string, then insertion order. It is not a BGP rule, it exists so `bestPath()`
is a pure function of its input set (`bgp.js:469-475`, `comparePrefix`).

### 4.2 Deliberately skipped RFC steps

| Step | Why not here |
|---|---|
| §9.1.2.2(e) interior cost to NEXT_HOP | Requires an IGP cost table keyed by next hop. `bgp.js` is topology-free by design. **Hook:** `comparePaths(a, b, { igpCost })` — when the caller supplies a function, it is evaluated between steps 7 and 8, restoring the RFC order exactly. `computeBgp()` can implement it from `dev.ospfRoutes`/interface costs later without touching the ordering contract. |
| Oldest route (vendor step between router-id and peer address) | Needs a clock. `bgp.js` has none, and determinism is a hard invariant. |
| Cluster-list length | No route reflectors (§1). |
| `AS_CONFED_*` | No confederations. Consequence: `no-export-subconfed` and `no-export` are the same thing (§5.4). |

### 4.3 Number types

Every comparison is on integers, never on strings: `net.ipToInt()` for
addresses, `parseAs()` for AS numbers, `Number()` for attributes. `'10.0.0.2'`
must sort below `'10.0.0.10'` (existing test: `bgp.test.js:460-461` extends to
the new peer-address step).

### 4.4 The pairwise comparator, final form

```js
// comparePaths(a, b, opts) -> negative | 0 | positive ; negative = a is better.
// opts: { alwaysCompareMed: false, localAs: 65001, igpCost: fn|null }
function comparePaths(a, b, opts) {
  // 1. weight, higher wins
  // 2. localPreference, higher wins          (eBGP paths already sanitised)
  // 3. locally originated wins
  // 4. asPathLength, shorter wins            (AS_SET = 1)
  // 5. originCode, lower wins
  // 6. med, lower wins -- ONLY if neighborAsOf(a) === neighborAsOf(b)
  //                        or opts.alwaysCompareMed
  // 7. pathRank, eBGP(0) before iBGP(1)
  // 8. igpCost, lower wins                   -- only if opts.igpCost supplied
  // 9. routerId, lower wins; absent sorts last
  // 10. peerAddress, lower wins; absent sorts last
  return 0;
}
```

`opts` is optional and defaults to `{}`; every existing two-argument call site
and every existing assertion keeps working.

### 4.5 `bestPath()` as an elimination pipeline

```js
// bestPath(list, opts) -> the winning object (identity preserved), or null.
// Implements RFC 4271 9.1.2.2's "remove from consideration" procedure so that
// set-valued rules (MED) and non-transitive rules behave, and so the winner
// cannot depend on the order of `list`.
function bestPath(candidates, opts) {
  let c = (candidates || []).filter(isObject);
  if (!c.length) return null;
  c = keepMax(c, function (p) { return num(p.weight, DEFAULT_WEIGHT); });            // 1
  c = keepMax(c, function (p) { return num(p.localPreference, DEFAULT_LOCAL_PREF); }); // 2
  if (c.some(isLocalPath)) c = c.filter(isLocalPath);                                 // 3
  c = keepMin(c, function (p) { return asPathLength(p.asPath); });                    // 4
  c = keepMin(c, function (p) { return originCode(p.origin); });                      // 5
  c = medEliminate(c, opts);                                                          // 6
  if (c.some(function (p) { return pathRank(p) === 0; })) {
    c = c.filter(function (p) { return pathRank(p) === 0; });                          // 7
  }
  if (typeof opts.igpCost === 'function') c = keepMin(c, opts.igpCost);               // 8
  c = keepMinBy(c, compareRouterId);                                                  // 9
  c = keepMinBy(c, comparePeerAddress);                                               // 10
  return c.slice().sort(function (x, y) { return comparePrefix(x.prefix, y.prefix); })[0];
}

// RFC 4271 9.1.2.2(c), verbatim in effect:
//   remove m if there exists n with the same neighbour AS and MED(n) < MED(m)
function medEliminate(list, opts) {
  const always = !!(opts && opts.alwaysCompareMed);
  return list.filter(function (m) {
    for (const n of list) {
      if (always || neighborAsOf(n, opts.localAs) === neighborAsOf(m, opts.localAs)) {
        if (num(n.med, DEFAULT_MED) < num(m.med, DEFAULT_MED)) return false;
      }
    }
    return true;
  });
}
```

`keepMax` / `keepMin` / `keepMinBy` are three-line filters, not sorts. Two
properties this buys us, both asserted in §11:

- **Order independence.** Every step is a filter over a set; no step depends on
  the order of the array. All permutations of a candidate list return the same
  winner.
- **Correct MED with 3+ paths.** Eliminating a route that is worse *within its
  own AS* is always safe: either the winner comes from that same AS (and the
  removed route was worse than a surviving sibling, which the elimination would
  also have removed), or the comparison is not made at all. So `medEliminate()`
  is safe with `always-compare-med` on or off.

For a two-path list the pipeline and `comparePaths()` must return the same
answer; that equivalence is itself a test (TB-A18).

---

## 5. Communities

`COMMUNITIES` is an **optional transitive** attribute: a set of 32-bit values
that ride along with the route across every AS boundary, unchanged, until
policy modifies them.

### 5.1 Representation

- Internal: `communities: [int, ...]` — a normalised, **sorted, de-duplicated**
  array of unsigned 32-bit integers. Always present (possibly `[]`). Sorted and
  unique so `show` output, equality checks and tests are deterministic.
- `communities` is *not* re-exported from `advertise()` as a set of objects; the
  integers travel as-is. No ASN parsing on egress.

### 5.2 Parsing (`parseCommunity`)

Accepted forms:

| Input | Result | Note |
|---|---|---|
| `65001:100` | `4259905636` (`0xFDE90064`) | AS part 1..65534, value part 0..65535 |
| `no-export` | `4294967041` (`0xFFFFFF01`) | RFC 1997 well-known |
| `no-advertise` | `4294967042` (`0xFFFFFF02`) | RFC 1997 well-known |
| `no-export-subconfed` | `4294967043` (`0xFFFFFF03`) | parsed; behaves as `no-export` here (§5.4) |
| `none` | `null` (only valid in `set community none`) | clears the attribute |

Rejected, with `% Invalid community "<x>" (use <as>:<value> with both 0..65535, or no-export|no-advertise)`:

- AS part `0` or `65535`. RFC 1997 reserves `0x00000000-0x0000FFFF` and
  `0xFFFF0000-0xFFFFFFFF`; `65535:x` lands in the second block, which is exactly
  where the well-known values live, so the symbolic name must be used instead.
- value part > 65535, non-numeric parts, a missing colon, more than one colon.
- `4`-octet-AS communities (`70000:100`). RFC 1997 encodes the AS in the first
  **two** octets; 4-octet-AS communities are a different attribute (large
  communities, RFC 8092) and are out of scope for this layer.

`formatCommunity(n)` is the inverse and is used by `show` and by
`running-config`: well-knowns print symbolically, everything else prints
`AS:VAL`.

### 5.3 Why `no-export` and `no-advertise` are exact, not approximate

| Community | Exact rule | Source |
|---|---|---|
| `no-export` | The route may be installed in Loc-RIB and advertised to **iBGP peers inside the AS**, but **must not** be advertised to any peer in another AS. Since this simulator has no confederations, "outside the AS" and "outside the confederation boundary" are the same boundary. | RFC 1997, "Well-known Communities / NO_EXPORT": "All routes received carrying a communities attribute containing this value MUST NOT be advertised outside a BGP confederation boundary (a stand-alone autonomous system that is not part of a confederation should be considered a confederation itself)" |
| `no-advertise` | The route **must not be advertised to any other BGP peer at all** — neither eBGP nor iBGP. It stays in Loc-RIB for local forwarding. | RFC 1997, "Well-known Communities / NO_ADVERTISE": "All routes received carrying a communities attribute containing this value MUST NOT be advertised to other BGP peers" |
| both present | `no-advertise` wins. It is strictly stronger, and a route matching two rules takes the tightest. | set semantics of the attribute |
| `no-export-subconfed` | Treated as `no-export`. | RFC 1997: "MUST NOT be advertised to external BGP peers (this includes peers in other members autonomous systems inside a BGP confederation)" — for a stand-alone AS this is byte-for-byte the NO_EXPORT rule |

Everything else about the attribute:

- Communities are **transitive**: `advertise()` copies them to eBGP and iBGP
  peers unchanged (RFC 1997, "COMMUNITIES attribute … optional transitive").
- Policy may add, replace or remove them (RFC 1997, "Operation": "A BGP speaker
  receiving a route with the COMMUNITIES path attribute may modify this
  attribute according to the local policy").
- A route that arrives without the attribute is treated as `[]`, and
  `set community X` creates it.
- Community suppression is checked **after** the outbound route-map, so a
  policy that *adds* `no-export` on egress is honoured. Outer order in
  `computeBgp()` per peer: split-horizon (§6.2, §6.3) → outbound route-map →
  community suppression → `advertise()` (§7.4), which prepends the AS number,
  chooses the next hop and strips the attributes in that order.

### 5.4 Where the check lives

```js
// bgp.communityBlocksAdvertisement(path, adjType) -> { ok, reason }
//   no-advertise  -> blocks eBGP and iBGP
//   no-export     -> blocks eBGP only
function communityBlocksAdvertisement(p, adjType) {
  const set = pathCommunities(p);
  if (set.indexOf(WELL_KNOWN_COMMUNITIES.NO_ADVERTISE) !== -1) {
    return { ok: false, reason: 'no-advertise' };
  }
  if (adjType === 'ebgp' && set.indexOf(WELL_KNOWN_COMMUNITIES.NO_EXPORT) !== -1) {
    return { ok: false, reason: 'no-export' };
  }
  return { ok: true, reason: null };
}
```

`advertise()` calls it too, so the function is safe to use as the single
reference implementation (a test asserts `advertise()` returns nothing for a
`no-advertise` route). The blocked route is *not* withdrawn from Loc-RIB and is
*not* counted as a policy deny — it is a protocol-level suppression, counted
separately (`stats.noExportSuppressed`, `stats.noAdvertiseSuppressed`).

---

## 6. AS-path loop prevention and the advertisement rules

Five rules, in the order they run. L1-L4 are protocol; L5 is the one that is
easy to get wrong because it is stated in prose rather than as a MUST.

### 6.1 L1 — never accept a path that contains our own AS

On ingress, if the local AS appears anywhere in the AS_PATH (AS_SET members
included), the route is **not** eligible for Phase 2 and never reaches the RIB.

> RFC 4271 §9.1.2: "If the AS_PATH attribute of a BGP route contains an AS loop,
> the BGP route should be excluded from the Phase 2 decision function. AS loop
> detection is done by scanning the full AS path (as specified in the AS_PATH
> attribute), and checking that the autonomous system number of the local system
> does not appear in the AS path."

`pathIsLoopFree()` (`bgp.js:304-317`) already implements this correctly,
including AS_SET members and the "unparseable AS can never match" case. Reuse
it; do not rewrite it. The check runs **after** the inbound route-map (policy
cannot clear an AS_PATH in this grammar) and **before** the route enters
`cands`.

### 6.2 L2 — never advertise a route back to the peer it came from

Per-peer Adj-RIB-Out bookkeeping. Each candidate remembers `from` (the peer id /
peer address it was received from); the Phase-3 loop skips that peer.

> RFC 4271 §3.2: the Adj-RIBs-Out hold "the routes that the BGP speaker has
> selected for advertisement to its peers"; §9.1.3: "All routes in the Loc-RIB
> are processed into Adj-RIBs-Out according to configured policy. This policy
> MAY exclude a route in the Loc-RIB from being installed in a particular
> Adj-RIB-Out."

The *reason* it is a rule rather than an optimisation is worth stating in the
code comment, because a reader will otherwise delete it:

- On an eBGP session we prepend our own AS to the AS_PATH before sending
  (RFC 4271 §5.1.2(b)). If we sent a route back to the peer we learned it from,
  that peer would see its own AS in the AS_PATH and reject it under L1. The
  advertisement is therefore *useless*, and suppressing it early avoids a
  pointless UPDATE (and, in the loop-detection-free case of a policy that
  rewrites AS paths, avoids a genuine loop).
- On an iBGP session the AS_PATH is not modified (RFC 4271 §5.1.2(a)), so L1
  would *not* catch it. There the `from` check is the only thing preventing a
  route from being handed straight back to the neighbour that sent it.

This is exactly what the advertisement loop in `computeBgp()` does today
(`if (e.from === adj.peer.dev.id) continue;`) and it must stay.

### 6.3 L3 — never re-advertise an iBGP-learned route to another iBGP peer

> RFC 4271 §9.2: "When a BGP speaker receives an UPDATE message from an internal
> peer, the receiving BGP speaker SHALL NOT re-distribute the routing information
> contained in that UPDATE message to other internal peers (unless the speaker
> acts as a BGP Route Reflector [RFC2796])."

**The current `computeBgp()` does not implement this.** The Phase-3 loop at
`computeBgp()` advertises every best path to every adjacency except the
one it came from, with no session-type check. With two iBGP speakers and one of
them also eBGP-connected, a route is relayed one iBGP hop further than the RFC
allows. Nothing in `test/bgp-wire.test.js` catches it because that topology is
three eBGP ASes.

Required change, in the advertisement loop:

```js
// RFC 4271 9.2: a route learned over iBGP is not relayed to other iBGP peers
// (no route reflectors in this layer).
if (adj.type === 'ibgp' && e.session === 'ibgp') continue;
```

Consequence to document in the CLI/help text: **iBGP requires a full mesh** in
this simulator, which is the real-world reason iBGP exists in a full mesh and
why `next-hop-self` is needed at the AS edge (§7.3). Route reflection is
explicitly out of scope and is the natural next RFC (RFC 4456) for a later
layer.

Keep L2 as well: L2 covers the eBGP case and the "same peer" iBGP case, L3
covers the "different iBGP peer" case. They are different rules with different
citations, and a test each.

### 6.4 L4 — AS_SET arithmetic

- Length: an AS_SET counts as **one** hop no matter how many ASes it contains.
  (RFC 4271 §9.1.2.2(a): "Note that when counting this number, an AS_SET counts
  as 1, no matter how many ASes are in the set.")
- Loop detection: every member of an AS_SET is scanned, so an AS_SET containing
  the local AS is a loop.
- Both are already correct in `asPathLength()` (`bgp.js:271-286`) and
  `pathIsLoopFree()` (`bgp.js:308-317`).

### 6.5 L5 — what is explicitly *not* implemented

| Not implemented | Why, and the citation that makes it a choice rather than an omission |
|---|---|
| `allowas-in` / accepting our own AS | RFC 4271 §9.1.2: "Operations of a BGP speaker that is configured to accept routes with its own autonomous system number in the AS path are outside the scope of this document." |
| `enforce-first-as` (drop an eBGP route whose leftmost AS ≠ `remoteAs`) | Not mandated by RFC 4271; it is deployment practice (see RFC 8212 for the "default deny" framing). Recorded here so that if it is added it is added as *policy*, not as a silent session-time check. |
| Route reflection / confederations | §1; RFC 4456, RFC 5065 are later layers. |

---

## 7. Next hop

`NEXT_HOP` says "send packets for this prefix to this address". Its rules differ
by session type, and getting them wrong is what breaks iBGP in practice.

### 7.1 Rules

| # | Rule | Source |
|---|---|---|
| NH-1 | **iBGP egress, route not locally originated: the next hop is NOT rewritten.** The external next hop learned at the AS edge is carried inside the AS unchanged. | RFC 4271 §5.1.3(1): "When sending a message to an internal peer, if the route is not locally originated, the BGP speaker SHOULD NOT modify the NEXT_HOP attribute unless it has been explicitly configured to announce its own IP address as the NEXT_HOP" |
| NH-2 | **iBGP egress, route locally originated: our own address**, specifically the address of the interface used to reach that peer (or the interface through which the announced network is reachable). | RFC 4271 §5.1.3(1), second sentence |
| NH-3 | **eBGP egress: rewritten to our own address on the session interface.** | RFC 4271 §5.1.3(2), final bullet: "By default … the BGP speaker SHOULD use the IP address of the interface that the speaker uses to establish the BGP connection to peer X" |
| NH-4 | **`next-hop-self`**: `neighbor <ip> next-hop-self` sets our own session address as the next hop even on an iBGP session. It is the explicit configuration NH-1 carves out, and it is the standard fix when the external next hop is not routable inside the AS. | RFC 4271 §5.1.3(1), "unless it has been explicitly configured to announce its own IP address as the NEXT_HOP" |
| NH-5 | Never advertise a route to a peer using **that peer's own address** as the next hop; never install a route whose next hop is ourselves. | RFC 4271 §5.1.3: "A route originated by a BGP speaker SHALL NOT be advertised to a peer using an address of that peer as NEXT_HOP. A BGP speaker SHALL NOT install a route with itself as the next hop." |
| NH-6 | A route whose NEXT_HOP is **not resolvable** in the RIB is excluded from Phase 2 and removed from Loc-RIB (kept in Adj-RIB-In so it can come back). | RFC 4271 §9.1.2: "If the NEXT_HOP attribute of a BGP route depicts an address that is not resolvable … the BGP route MUST be excluded from the Phase 2 decision function"; §9.1.2.1 |

### 7.2 Why NH-1 is the interesting rule

Three routers, `R1` (AS 65001) — `R2` (AS 65001, iBGP) — `R3` (AS 65002):

```
R1 ---eBGP--- R3        R1 learns 10.0.3.0/24 with NEXT_HOP 10.0.13.3
 |                       R1 advertises it to R2 over iBGP
iBGP                    NH-1: the next hop stays 10.0.13.3
 |                       R2 has no route to 10.0.13.3 (it is not on a
R2                      subnet R2 is attached to) -> NH-6: route unusable
```

That is not a simulator artifact, it is the reason `next-hop-self` exists: the
fix is `neighbor 10.0.12.2 next-hop-self` on R1, after which R2 receives
NEXT_HOP = 10.0.12.1, which it *can* resolve. The assertion table contains both
halves of this story (NH-5, NH-6) because it is the single most instructive
behaviour in this document.

### 7.3 Implementation

```js
// bgp.nextHopFor(route, opts) -> string|null
// opts: { type: 'ebgp'|'ibgp', localIp, peerIp, nextHopSelf, localAs }
function nextHopFor(route, opts) {
  if (opts.type === 'ebgp') {
    // NH-3
    return opts.localIp;
  }
  // NH-4
  if (opts.nextHopSelf || isLocalPath(route)) return opts.localIp;
  // NH-1: carry the learned next hop through, unchanged
  return (typeof route.nextHop === 'string' && route.nextHop.trim() !== '')
    ? route.nextHop.trim() : null;
}
```

And NH-5 as a guard applied after `nextHopFor()`:

```js
if (nh !== null && parseIp(nh) === parseIp(opts.peerIp)) nh = opts.localIp;
```

### 7.4 Attribute rewrite order on egress (one place, one order)

`advertise(routes, opts)` is the single reference implementation of the export
side. `computeBgp()` must call it instead of re-deriving the AS path at
`computeBgp()` builds inline. Order inside `advertise()`:

1. resolve session type (`ebgp` / `ibgp`) — from `opts.type`, else `peerAs`;
2. **AS_PATH**: eBGP prepends the local AS (`[localAs].concat(path)`), iBGP does
   not (RFC 4271 §5.1.2(a)/(b));
3. **NEXT_HOP** via `nextHopFor()` (§7.3), then the NH-5 guard;
4. **LOCAL_PREF**: `null` for eBGP (§2.2), carried for iBGP;
5. **MED**: the `medSource` rule in §3.2;
6. **COMMUNITIES**: copied, then community suppression checked (§5.4);
7. **ORIGIN**, `from`, `prefix`: copied through unchanged.

`advertise()` output keys become exactly:

```
['asPath', 'communities', 'from', 'localPreference', 'med', 'nextHop', 'origin', 'prefix']
```

(one new key; existing key-list assertion `test/bgp.test.js:351-353` must be
updated — §11).

---

## 8. Route maps: the policy engine

A route map is an ordered list of entries. First match wins; **no match is an
implicit deny** (this is the one place where "not configured" and "denied"
differ, and it must be documented in `_help`).

### 8.1 Entry shape

```js
{ seq: 10, action: 'permit' | 'deny',
  match: { community: [int, ...], exact: false },
  set:   { localPreference: 200, med: 400, medSet: true,
           community: [int, ...], communityMode: 'replace'|'additive'|'none',
           weight: 50, origin: 0, nextHop: '192.0.2.1' } }
```

`dev.config.routeMaps = { 'NAME': [entry, ...] }`, sorted by `seq` at
application time (stored in insertion order, sorted on use, so `no route-map`
and re-entry stay simple).

### 8.2 Application pipeline

| Direction | Runs | Citation |
|---|---|---|
| `in` | After the UPDATE is received, **before** the route enters the Adj-RIB-In / `cands`: sanitise the attributes as received (§2.2, `LOCAL_PREF` from an eBGP peer is dropped here) → AS-loop check (§6.1) → inbound route-map → install. `set local-preference` in that route-map is the degree of preference, and it overwrites the sanitised baseline. | RFC 4271 §9.1.1 |
| `out` | In Phase 3, per peer, per Adj-RIB-Out: split-horizon (§6.2, §6.3) → outbound route-map → community suppression (§5.4) → attribute rewrite in the fixed order of §7.4. | RFC 4271 §9.1.3 |

A `deny` entry stops processing: on ingress the route is not installed and
`stats.deniedIn++`; on egress the route is not advertised to that peer and
`stats.deniedOut++`. A `permit` entry applies its `set` clauses and stops
looking.

### 8.3 `set` legality matrix

| `set` verb | `in` | `out` to iBGP | `out` to eBGP | Why |
|---|---|---|---|---|
| `local-preference` | allowed, becomes DoP | allowed, carried | **accepted but never encoded** (+ note line) | RFC 4271 §5.1.5, §9.1.1 |
| `metric` (MED) | allowed | allowed | allowed | §5.1.4, §9.1.2.2(c) — MED exists to be sent to a neighbour |
| `community` | allowed | allowed | allowed | RFC 1997 (transitive, policy-modifiable) |
| `weight` | allowed | **refused** at config time | **refused** at config time | `weight` is router-local and never leaves the router; configuring it outbound is always a mistake |
| `origin` | allowed | allowed | allowed | §5.1.2, ORIGIN is a normal attribute |
| `next-hop` | **refused** at config time | allowed | allowed | an inbound next hop describes a peer, not us; rewriting it inbound breaks NH-6 resolution |

Refusals are config-time CLI errors, not silent drops:

```
% set weight is local to this router and is never advertised (use an inbound route-map)
% set next-hop is only valid in an outbound route-map
```

### 8.4 `match` vocabulary (deliberately small)

| Match | Semantics |
|---|---|
| `match community <c>` | true if the route's community set **contains** `c` (subset semantics, RFC 1997 gives no ordering) |
| `match community <c> [<c> ...]` | true if **any** listed community is present |
| `match community <c> exact` | true only if the route's set is exactly the listed set |
| `match community` with no operand | CLI error: `% Incomplete command` (matches existing style: `% Incomplete command` in `_configMode()`) |

Prefix-list / as-path-list / `match ip address` are out of scope for this
layer. `match ip address <acl>` is the obvious next addition because
`engine/acl.js` already exists — recorded in §12 so the shape stays compatible.

---

## 9. CLI grammar

The parser is a flat token dispatcher: `run()` splits on whitespace,
`_configMode()` / `_ifaceMode()` / `_show()` switch on `tokens[0]`, sub-modes are
private methods that receive the remaining tokens and return an array of output
lines. Errors start with `% `, successes do not, every unknown path prints a
`% Usage: ...` line listing the alternatives. The additions below follow that
exactly — no new prompt mode, no new tokenizer, no change to `prompt()`.

### 9.1 Config mode — dispatch additions

```js
// in _configMode(), next to the existing BGP branches
} else if (head === 'route-map') {
  out.push.apply(out, this._routeMap(tokens.slice(1)));
} else if (head === 'no' && tokens[1] === 'route-map') {
  out.push.apply(out, this._routeMap(['no'].concat(tokens.slice(2))));
} else if (head === 'match' || head === 'set') {
  out.push.apply(out, this._routeMapEntry(tokens));
} else if (head === 'no' && (tokens[1] === 'match' || tokens[1] === 'set')) {
  out.push.apply(out, this._routeMapEntry([tokens[1], 'no'].concat(tokens.slice(2))));
}
```

`neighbor ...` never reaches these branches: `head === 'neighbor'` is already
routed to `_bgp(tokens.slice(1))` in `_configMode()`, so
`neighbor <ip> route-map <name> in` is parsed inside `_bgp`, exactly like
`neighbor <ip> remote-as <as>`.

### 9.2 The route-map context is sticky, like a DNS zone

There is no `(config-route-map)#` prompt. `route-map NAME permit 10` sets
`this._routeMap = { name, seq, action }`, and subsequent bare `match` / `set`
commands in config mode apply to it. This mirrors `this._dnsZone`
(set when a `dns zone` is entered), the existing precedent for a sticky sub-context, and keeps
`prompt()` and the four mode constants untouched. `this._routeMap` is cleared by
`exit`/`end` (mode change to exec) and by `no route-map` on the same name.

Bare `match`/`set` with no context is an error:
`% No route map selected (use "route-map <name> permit <seq>")`.

### 9.3 Command reference

| Mode | Command | Success output | Error output |
|---|---|---|---|
| config | `router bgp <as>` | `BGP enabled, local AS <as>` | `% Invalid AS number "<x>"` |
| config | `no router bgp` | `BGP disabled` | — |
| config | `bgp router-id <ip>` | `BGP router-id <ip>` | `% Invalid router-id "<x>"`, `% BGP is not enabled (use "router bgp <as>")` |
| config | `bgp always-compare-med` | `BGP always-compare-med enabled` | `% BGP is not enabled (use "router bgp <as>")` |
| config | `no bgp always-compare-med` | `BGP always-compare-med disabled` | `% BGP is not enabled (use "router bgp <as>")` |
| config | `bgp default local-preference <n>` | `BGP default local-preference <n>` | `% local-preference must be 0..4294967295, got "<x>"` |
| config | `neighbor <ip> remote-as <as>` | `BGP neighbor <ip> remote-as <as>` | `% Invalid remote AS "<x>"`, `% BGP is not enabled (use "router bgp <as>" first)` |
| config | `neighbor <ip> route-map <name> in\|out` | `BGP neighbor <ip> route-map <name> <dir>` (+ note line if §2.2 case) | `% No such neighbor <ip>`, `% Route map "<name>" does not exist` |
| config | `no neighbor <ip> route-map in\|out` | `Neighbor <ip> route-map <dir> removed` | `% No such neighbor <ip>` |
| config | `neighbor <ip> next-hop-self` | `BGP neighbor <ip> next-hop-self` | `% No such neighbor <ip>` |
| config | `no neighbor <ip> next-hop-self` | `BGP neighbor <ip> next-hop-self disabled` | `% No such neighbor <ip>` |
| config | `route-map <name> permit\|deny [<seq>]` | `Route map <name> <action> <seq>` | `% Invalid route map name "<x>"`, `% Invalid sequence "<x>"` (1..65535) |
| config | `no route-map <name>` | `Route map <name> removed` | `% No such route map "<name>"` |
| config | `no route-map <name> permit\|deny <seq>` | `Route map <name> entry <seq> removed` | `% No such route map entry <seq>` |
| config | `match community <c> [<c> ...] [exact]` | `Match community <c,...>` | `% Invalid community "<x>" ...`, `% No route map selected (...)` |
| config | `no match community` | `Match community removed` | `% No route map selected (...)` |
| config | `set local-preference <n>` | `Set local-preference <n>` | `% local-preference must be 0..4294967295, got "<x>"` |
| config | `set metric <n>` | `Set metric <n>` | `% metric must be 0..4294967295, got "<x>"` |
| config | `set metric none` | `Set metric none (MED stripped)` | — |
| config | `set community <c>[,<c>...] [additive]` | `Set community <c,...>[ additive]` | `% Invalid community "<x>" ...` |
| config | `set community none` | `Set community none (communities cleared)` | — |
| config | `set weight <n>` | `Set weight <n>` | `% weight must be 0..65535, got "<x>"`, `% set weight is local to this router and is never advertised (use an inbound route-map)` |
| config | `set origin igp\|egp\|incomplete` | `Set origin <x>` | `% Invalid origin "<x>" (use igp, egp or incomplete)` |
| config | `set next-hop <ip>` | `Set next-hop <ip>` | `% Invalid next-hop "<x>"`, `% set next-hop is only valid in an outbound route-map` |
| config | `no set <verb>` | `Set <verb> removed` | `% No route map selected (...)` |
| exec | `show ip bgp [<prefix>]` | table, §10 | `% No BGP routes` |
| exec | `show ip bgp neighbors <ip> [advertised-routes\|received-routes]` | §10 | `% No such neighbor <ip>` |
| exec | `show route-map [<name>]` | §10 | `% No route maps configured`, `% No such route map "<name>"` |

Note on `set metric none`: this verb is a simulator extension required by
RFC 4271 §5.1.4's "MUST implement a mechanism … that allows the
MULTI_EXIT_DISC attribute to be removed". It does not contradict any existing
command, because the CLI has no `set` verbs at all today.

Sequence numbers: when omitted, auto-assign `previous + 10`, starting at 10
(so `route-map EXPORT permit` then `route-map EXPORT deny` yields 10 and 20,
in that order). Re-issuing the same `name action seq` re-selects the existing
entry (editing, not duplicating) — the same "re-declaring updates rather than
duplicates" behaviour already required of `neighbor ... remote-as`
(`test/bgp-wire.test.js:60-61`).

### 9.4 `_help()` additions

Append these lines to `_help()`, keeping the existing column
alignment:

```
  router bgp <as>                      neighbor <ip> remote-as <as>
  neighbor <ip> route-map <name> in|out     neighbor <ip> next-hop-self
  bgp always-compare-med               bgp default local-preference <n>
  route-map <name> permit|deny [<seq>]      match community <c> [exact]
  set local-preference <n> | set metric <n> | set community <c> [additive]
  show ip bgp [<prefix>] | show ip bgp neighbors <ip> | show route-map
```

### 9.5 Data model

```js
// device.config.bgp
{
  as: 65001,
  routerId: '1.1.1.1',
  alwaysCompareMed: false,          // default false (RFC 4451 3.3 / 4.1 caution)
  defaultLocalPreference: 100,      // bgp default local-preference
  neighbors: [{
    address: '10.0.12.2',
    remoteAs: 65002,
    routeMapIn: null,               // string | null
    routeMapOut: null,
    nextHopSelf: false
  }]
}

// device.config.routeMaps  (top-level, so OSPF can reuse it later)
{ 'NAME': [ { seq, action, match, set } ] }

// a path / candidate (extends today's object; all new fields optional)
{
  dest, mask, asPath, origin, localPreference, med, weight,
  communities: [],                  // NEW  sorted unique ints
  nextHop, ad, from, session, peerAs,
  localPrefSource: 'peer',          // NEW  peer|policy|default|ignored
  medSource: 'none',                // NEW  peer|policy|none
  peerAddress: '10.0.12.2',         // NEW  tiebreak 9
  routerId: '2.2.2.2',
  iface
}
```

`bgp.js` must export the new helpers so they can be unit-tested without a
topology, in the same flat style as the current export list
(`bgp.js:542-558`):

```
DEFAULT_LOCAL_PREF, DEFAULT_MED, DEFAULT_WEIGHT,
LOCAL_PREF_MAX, MED_MAX, WELL_KNOWN_COMMUNITIES,
parseCommunity, formatCommunity, normalizeCommunities, pathCommunities,
hasCommunity, communityBlocksAdvertisement,
neighborAsOf, medEliminate,
comparePaths, comparePeerAddress, bestPath,
advertise, nextHopFor, ingressPath, applyRouteMap
```

### 9.6 Observability

`computeBgp()` already emits one `{type:'bgp'}` event per established session
(`Simulator.computeBgp()`, where the policy counters are read). Add, on `device.bgpPolicyStats`:

```
{ deniedIn, deniedOut, localPrefIgnored, noExportSuppressed,
  noAdvertiseSuppressed, loopDropped, unresolvable }
```

and emit `{type:'bgp-policy', dev, peer, prefix, rule}` when a rule fires, so
the UI can show *why* a route did not appear. A route that is suppressed must
never disappear silently — that is the whole point of a policy layer.

---

## 10. `show` output

`show ip bgp` (one row per Loc-RIB prefix; `>` marks the selected path, `*`
marks a valid candidate, `r` marks a RIB-failure/unresolvable path):

```
BGP table version is 4, local router ID is 1.1.1.1
Status codes: > best, * valid, r RIB-failure
Origin codes: i - IGP, e - EGP, ? - incomplete

   Network          Next Hop      Metric LocPrf Weight Path
*> 10.0.3.0/24      10.0.12.2          0    100      0 65002 65003 i
*  10.0.3.0/24      10.0.13.3        200    100      0 65004 65003 i
*> 10.0.1.0/24      0.0.0.0            0    100      0 i
```

`show ip bgp neighbors <ip> advertised-routes` adds the two columns that make
policy debuggable, `Community` and `MED source`, because "why did my
`set metric` not appear" is otherwise unanswerable:

```
   Network          Next Hop      Metric LocPrf Path              Communities
*> 10.0.3.0/24      10.0.12.1        400  100    65001 65002 65003 no-export
```

`show route-map [<name>]` echoes the stored entries in CLI form so that
`show running-config` round-trips:

```
route map EXPORT, permit, sequence 10
  Match clauses:
    community 65001:100
  Set clauses:
    metric 400
    community 65001:100 additive
```

`show running-config` must emit, in this order and in this syntax, so that the
output can be pasted back:

```
router bgp 65001
bgp router-id 1.1.1.1
bgp always-compare-med
bgp default local-preference 120
neighbor 10.0.12.2 remote-as 65002
neighbor 10.0.12.2 next-hop-self
neighbor 10.0.12.2 route-map IMPORT in
neighbor 10.0.12.2 route-map EXPORT out
route-map IMPORT permit 10
set local-preference 200
route-map EXPORT permit 10
set metric 400
set community 65001:100 additive
```

---

## 11. Assertions the implementation must satisfy

Style follows `test/bgp.test.js` (`ok(cond, msg)`, one behaviour per line) and
`test/bgp-wire.test.js` (real topology, `runCommands()`, then assert on
`dev.bgpRoutes` / `routeTo()`). New file: `test/bgp-policy.test.js` (unit) and
`test/bgp-policy-wire.test.js` (topology). Wire it into `package.json`'s `test`
and `test:bgp-policy` scripts.

### 11.1 LOCAL_PREF

| ID | Given | Assertion | Ref |
|---|---|---|---|
| LP-A1 | `mkPath({localPreference:200})` vs `mkPath({localPreference:100})` | `comparePaths(...) < 0` — higher wins | §2.1, RFC 4271 §5.1.5 |
| LP-A2 | LP 300 path with a 4-AS path vs LP 100 path with a 1-AS path | `comparePaths(...) < 0` — LP precedes AS-path length | §2.3 |
| LP-A3 | `ingressPath({localPreference:999}, 'ebgp')` | `.localPreference === 100` and `.localPrefSource === 'ignored'` | LP-5 |
| LP-A4 | `ingressPath({localPreference:250}, 'ibgp')` | `.localPreference === 250` — untouched | LP-2 |
| LP-A5 | `advertise([{localPreference:150}], {type:'ebgp'})[0]` | `.localPreference === null` — not encoded | LP-4 |
| LP-A6 | `advertise([{localPreference:150}], {type:'ibgp'})[0]` | `.localPreference === 150` | LP-3 |
| LP-A7 | eBGP path carrying 999 vs iBGP path carrying 100, both otherwise equal | `bestPath(...)` returns the **iBGP** path | LP-5 end to end |
| LP-A8 | `bgp default local-preference 250`, then a connected prefix is originated | originated candidate `.localPreference === 250`, and its iBGP advertisement carries 250 | LP-6 |
| LP-A9 | outbound eBGP route-map with `set local-preference 500` | CLI stderr contains `local-preference is not advertised to external peers`, and the peer's received path has `.localPreference === 100` | §2.2 |
| LP-A10 | inbound eBGP route-map with `set local-preference 200` | installed path `.localPreference === 200` and `.localPrefSource === 'policy'` | LP-3, RFC 4271 §9.1.1 |

### 11.2 MED

| ID | Given | Assertion | Ref |
|---|---|---|---|
| MED-A1 | same AS_PATH `[65001]`, med 10 vs 50 | `comparePaths(...) < 0` | MED-1 |
| MED-A2 | `asPath:[65001]` med 10 vs `asPath:[65002]` med 50 | `comparePaths(...) === 0` — MED not comparable | MED-3 |
| MED-A3 | as MED-A2 but `{alwaysCompareMed:true}` | `< 0` | MED-5 |
| MED-A4 | `med:0` vs `med:undefined`, same AS_PATH | `comparePaths(...) === 0` — absent is 0 | MED-2 |
| MED-A5 | `med:0` vs `med:1`, same AS_PATH | `< 0` — zero is not "worse than missing" | MED-2, RFC 4451 §3.2 |
| MED-A6 | paths (AS1,10) (AS1,20) (AS2,5); all 6 permutations | `bestPath` returns the same object every time, and `medEliminate` drops only the (AS1,20) path | §3.4, §4.5 |
| MED-A7 | two iBGP paths, `asPath:[65010]` vs `asPath:[65020]`, med 10 vs 50 | `=== 0` — relayed by iBGP, still different neighbour AS | MED-4 |
| MED-A8 | two iBGP paths, both `asPath:[]`, med 10 vs 50 | `< 0` — both originated here, so both neighbour AS = local | MED-4 |
| MED-A9 | `advertise([{med:20}], {type:'ebgp'})[0].med` | `=== null` — inherited MED is not propagated to another AS | MED-6, RFC 4271 §5.1.4 |
| MED-A10 | `advertise([{med:20}], {type:'ibgp'})[0].med` | `=== 20` — carried over iBGP | MED-7 |
| MED-A11 | `set metric 400` outbound to eBGP | advertised `.med === 400` | MED-9 |
| MED-A12 | `set metric none` on a path with med 20, advertised to iBGP | `.med === null` | MED-8 |
| MED-A13 | wire test: R1 has two eBGP peers in AS 65002 and AS 65003 advertising the same prefix with MED 50 and MED 10 | with `always-compare-med` **off**, the winner is decided by steps 7-9 (different neighbour AS ⇒ MED ignored); with it **on**, the MED 10 path wins | MED-3/MED-5 end to end |

### 11.3 Communities

| ID | Given | Assertion | Ref |
|---|---|---|---|
| COM-A1 | `parseCommunity('65001:100')` | `=== 4259905636` (`0xFDE90064`) | §5.2 |
| COM-A2 | `parseCommunity('no-export')` / `('no-advertise')` | `4294967041` / `4294967042` | RFC 1997 |
| COM-A3 | `formatCommunity(parseCommunity(x)) === x` for `65001:100`, `no-export`, `no-advertise` | round-trip | §5.2 |
| COM-A4 | `parseCommunity('0:100')`, `('65535:1')`, `('65001:70000')`, `('65001')`, `('nonsense')` | all `null` | §5.2 (reserved ranges) |
| COM-A5 | `normalizeCommunities([4294967041, 4259905636, 4294967041])` | `[4259905636, 4294967041]` — sorted, unique | §5.1 |
| COM-A6 | route with `no-export`, advertise to eBGP | `advertise(...).length === 0` | §5.3 |
| COM-A7 | route with `no-export`, advertise to iBGP | `length === 1`, community preserved | §5.3 |
| COM-A8 | route with `no-advertise` | `length === 0` for eBGP **and** iBGP | §5.3 |
| COM-A9 | route with both | blocked on iBGP too — `no-advertise` wins | §5.3 |
| COM-A10 | route with `65001:100` advertised over eBGP then iBGP | set unchanged at both hops (transitive) | RFC 1997 |
| COM-A11 | `set community 65001:200 additive` on `[65001:100]` | `[65001:100, 65001:200]` | §5.3 |
| COM-A12 | `set community 65001:200` (no additive) on `[65001:100]` | `[65001:200]` — replace | §5.3 |
| COM-A13 | `set community none` | `[]` | §5.3 |
| COM-A14 | `match community 65001:100` vs a route carrying `[65001:100, 65001:200]` | matches | §8.4 |
| COM-A15 | same with `exact` | does not match | §8.4 |
| COM-A16 | route satisfying no route-map entry | denied (implicit deny), `stats.deniedIn === 1` | §8.2 |
| COM-A17 | outbound route-map that **adds** `no-export` to an eBGP advertisement | route is suppressed — the check runs after policy | §5.4 |

### 11.4 Loops

| ID | Given | Assertion | Ref |
|---|---|---|---|
| LOOP-A1 | `pathIsLoopFree([65002, [65001, 65003]], 65001)` | `false` — AS_SET member is scanned | §6.4 |
| LOOP-A2 | path whose AS_PATH starts with the local AS, delivered over eBGP | not installed in `bgpRoutes`; `stats.loopDropped === 1` | §6.1 |
| LOOP-A3 | 3-AS line topology | for every peer P, no path in P's received candidates has `.from === P` | §6.2 |
| LOOP-A4 | R1—R2 iBGP, R1 also eBGP to R3, R3 originates a prefix | R2's table has the prefix with `asPath` `[65002]` and R2 does **not** re-advertise it to a third iBGP peer R4 | §6.3 (currently fails) |
| LOOP-A5 | same topology, `MAX_ROUNDS` | `computeBgp()` returns before exhausting 12 rounds, and each AS path string is exactly the expected sequence | §6.3, determinism |

### 11.5 Next hop

| ID | Given | Assertion | Ref |
|---|---|---|---|
| NH-A1 | eBGP advertisement | `nextHop === opts.localIp` | NH-3 |
| NH-A2 | iBGP advertisement of a route learned with next hop `10.0.13.3` | `nextHop === '10.0.13.3'` — unchanged | NH-1 |
| NH-A3 | same, `nextHopSelf: true` | `nextHop === opts.localIp` | NH-4 |
| NH-A4 | locally originated route to an iBGP peer | `nextHop === opts.localIp` | NH-2 |
| NH-A5 | `nextHopFor()` where the computed next hop equals `peerIp` | returns `localIp`, never the peer's own address | NH-5 |
| NH-A6 | wire: R1—R2 iBGP, R1—R3 eBGP, R3 originates 10.0.3.0/24 | R2 has the prefix but **no** route to it (`routeTo()` not `bgp`), i.e. it is marked unresolvable | NH-6 |
| NH-A7 | same topology + `neighbor <R2> next-hop-self` on R1 | R2 now has a usable BGP route and a ping from R2's LAN to 10.0.3.x succeeds | NH-4/NH-6 |

### 11.6 Tiebreakers

| ID | Given | Assertion | Ref |
|---|---|---|---|
| TB-A1 | weight 200 vs 100 | higher wins | §4.1 step 1 |
| TB-A2 | weight 50 + LP 50 vs weight 60 | weight outranks LP | step 1 |
| TB-A3 | LP 200 vs 100 | higher wins | step 2 |
| TB-A4 | LP 300 + 4-AS path vs LP 100 + 1-AS | LP outranks AS path | step 2 |
| TB-A5 | `local:true` + 3-AS path vs 1-AS path | local wins | step 3 |
| TB-A6 | 1-AS vs 3-AS | shorter wins | step 4 |
| TB-A7 | `[65001,[65010,65020]]` vs `[65001,65002]` | `=== 0` — AS_SET weighs 1 | step 4 |
| TB-A8 | origin IGP vs EGP vs INCOMPLETE | IGP < EGP < INCOMPLETE | step 5 |
| TB-A9 | med 999 + origin EGP vs med 0 + origin IGP | origin outranks MED | step 5 > 6 |
| TB-A10 | med 10 vs 50, same neighbour AS | lower MED wins | step 6 |
| TB-A11 | med 900 eBGP vs med 0 iBGP, **same** AS_PATH | MED outranks session type ⇒ iBGP wins | step 6 > 7 |
| TB-A12 | eBGP vs iBGP, otherwise identical | eBGP wins | step 7 |
| TB-A13 | router-id `1.1.1.1` vs `2.2.2.2` | lower wins | step 8 |
| TB-A14 | router-id `10.0.0.2` vs `10.0.0.10` | lower wins — numeric, not lexical | step 8 |
| TB-A15 | identical router-id, peer `10.0.0.2` vs `10.0.0.10` | lower peer address wins | step 9 (**new**) |
| TB-A16 | both router-id and peer address absent | `comparePaths(...) === 0`; `bestPath` still returns deterministically via the prefix guard | §4.1 |
| TB-A17 | `bestPath` over all 6 permutations of 3 candidates | identical winner object every time | §4.5 |
| TB-A18 | a 2-path list | `bestPath` winner === the one `comparePaths` prefers | §4.5 |

### 11.7 CLI

| ID | Command | Assertion |
|---|---|---|
| CLI-A1 | `router bgp 65001` | output `BGP enabled, local AS 65001`, `config.bgp.as === 65001` |
| CLI-A2 | `bgp router-id 1.1.1.1` | `config.bgp.routerId === '1.1.1.1'` |
| CLI-A3 | `neighbor 10.0.12.2 remote-as 65002` twice with a different AS | one neighbour, updated not duplicated |
| CLI-A4 | `neighbor 10.0.12.2 next-hop-self` | `neighbors[0].nextHopSelf === true` |
| CLI-A5 | `route-map EXPORT permit 10` | output `Route map EXPORT permit 10`, entry created with `seq === 10` |
| CLI-A6 | `route-map EXPORT deny` (no seq) after the above | new entry with `seq === 20`, action `deny` |
| CLI-A7 | `set metric 400` with no route-map selected | `% No route map selected (use "route-map <name> permit <seq>")` |
| CLI-A8 | `set local-preference 4294967296` | `% local-preference must be 0..4294967295, got "4294967296"` |
| CLI-A9 | `set community 65535:1` | `% Invalid community "65535:1" ...` |
| CLI-A10 | `neighbor 10.0.12.2 route-map NOPE in` | `% Route map "NOPE" does not exist` |
| CLI-A11 | `set weight 20` in an outbound map | `% set weight is local to this router and is never advertised ...` |
| CLI-A12 | `bgp always-compare-med` | `config.bgp.alwaysCompareMed === true`; `no bgp always-compare-med` clears it |
| CLI-A13 | `show ip bgp` | contains `LocPrf`, the prefix, and the AS path string |
| CLI-A14 | `show route-map EXPORT` | round-trips through `show running-config` (re-run the emitted commands, compare `config.routeMaps`) |
| CLI-A15 | `no route-map EXPORT` | entries gone **and** any `neighbors[].routeMapIn/Out` referencing it is cleared to `null` |

### 11.8 Existing assertions that must change

Named exactly, so the implementer does not have to hunt:

| Location | Today | After |
|---|---|---|
| `test/bgp.test.js:340-341` | `ebgpOut[0].localPreference === 100 && ebgpOut[1].localPreference === 150` — "local preference is carried per route" | `ebgpOut[0].localPreference === null && ebgpOut[1].localPreference === null` — "LOCAL_PREF is not carried over eBGP (RFC 4271 5.1.5)"; the "carried per route" check moves to `ibgpOut` |
| `test/bgp.test.js:344` | `ebgpOut[0].med === 20 && ebgpOut[1].med === 0` — "MED is carried per route" | `ebgpOut[0].med === null && ebgpOut[1].med === null` — "inherited MED is not propagated to another AS"; move the "carried" check to `ibgpOut` |
| `test/bgp.test.js:351-353` | key list has 7 keys | 8 keys: add `communities` |
| `test/bgp.test.js:452` | MED 900 eBGP vs MED 0 iBGP, `> 0` | **unchanged** — `mkPath()` gives both paths `asPath:[65001]`, so they share a neighbour AS and are comparable |
| `test/bgp.test.js:439-442` | MED 10 vs 50 | **unchanged**, same reason |
| `computeBgp()` — AS path and next hop | Derived inline, not via `advertise()` | call `advertise()` — behaviour identical for eBGP, corrected for iBGP (NH-1) |
| `computeBgp()` advertisement loop | Advertises iBGP→iBGP | add the §6.3 suppression (a behaviour change; no existing wire test covers it) |

`test/bgp-wire.test.js` is all-eBGP and should pass untouched; that is the
regression gate for "the policy layer did not break plain BGP".

---

## 12. Out of scope, recorded so it is not re-invented

| Topic | RFC | Why it waits |
|---|---|---|
| Route reflection | RFC 4456 | needs `routeReflectorClient` (already reserved in `normalizePeer`) plus ORIGINATOR_ID/CLUSTER_LIST, i.e. two more attribute types and a cluster-list tiebreak |
| Confederations | RFC 5065 | would make `no-export-subconfed` distinct from `no-export`; the attribute is parsed now so the data model does not have to change later |
| Large communities | RFC 8092 | 12-octet values; the parser deliberately rejects 4-octet-AS forms of the 32-bit attribute instead of guessing |
| `match ip address <acl>` | — | natural next step; `engine/acl.js` already provides `parseEntry`/`aclKind`, and route maps were placed in `dev.config.routeMaps` (not under `bgp`) so OSPF policy can share them |
| `enforce-first-as` | practice, not RFC 4271 | see §6.5 |
| `allowas-in` | — | RFC 4271 §9.1.2 declares it out of scope |
| Damping, `minimum-route-age`, timers | RFC 2439 | needs a clock; `bgp.js` has none |

---

## 13. References

- **RFC 4271**, *A Border Gateway Protocol 4 (BGP-4)*, January 2006.
  - §5.1.2 `AS_PATH` (prepend on eBGP, leave alone on iBGP, empty path for
    locally originated routes) — §6.2, §6.4, §7.4.
  - §5.1.3 `NEXT_HOP` (iBGP does not rewrite, explicit own-address
    configuration, eBGP default rewrite, "SHALL NOT advertise using the peer's
    address", "SHALL NOT install a route with itself as next hop") — §7.1-§7.3.
  - §5.1.4 `MULTI_EXIT_DISC` (optional non-transitive, lower preferred, may go
    over iBGP, **MUST NOT** cross into another AS, MUST provide removal) — §3.
  - §5.1.5 `LOCAL_PREF` (well-known, higher preferred, **MUST NOT** be sent to
    external peers, **MUST** be ignored when received from them) — §2.
  - §9.1.1 Phase 1 / degree of preference (iBGP: LOCAL_PREF *is* the DoP;
    eBGP: DoP comes from local policy and is carried into iBGP) — §2.1, §2.3.
  - §9.1.2 Phase 2 (AS-loop exclusion; unresolvable NEXT_HOP exclusion;
    "the highest degree of preference") — §6.1, §7.1.
  - §9.1.2.1 route resolvability — NH-6.
  - §9.1.2.2 breaking ties: (a) AS-path length with AS_SET = 1, (b) ORIGIN,
    (c) MED — *only between routes from the same neighbouring AS*, absent = 0,
    (d) eBGP over iBGP, (e) interior cost, (f) lowest BGP Identifier,
    (g) lowest peer address — §4.1, §4.2, §3.1, §3.3.
  - §9.1.3 Phase 3 / Adj-RIBs-Out policy — §6.2, §8.2.
  - §9.2 update-send (no iBGP→iBGP relaying without a route reflector) — §6.3.
  - §3.2 Adj-RIBs-Out definition — §6.2.
- **RFC 1997**, *BGP Communities Attribute*, August 1996. Unnumbered sections;
  cited by heading: "COMMUNITIES attribute" (optional transitive, 32-bit values,
  AS in the first two octets, reserved `0x00000000-0x0000FFFF` and
  `0xFFFF0000-0xFFFFFFFF`), "Well-known Communities" (`NO_EXPORT`,
  `NO_ADVERTISE`, `NO_EXPORT_SUBCONFED` and their exact MUST NOT rules),
  "Operation" (policy may modify the attribute).
- **RFC 4451**, *BGP MULTI_EXIT_DISC (MED) Considerations*, March 2006.
  §2.1 (restates §5.1.4), §3.1 (non-transitive, advertisement discretionary),
  §3.2 (missing MED = 0; implementations historically disagreed), §3.3
  (comparing MED between different ASes exists and is risky), §3.4
  (oscillation with route reflection/confederations), §4.1 (deployment advice).
- **RFC 1998**, *An Application of the BGP Community Attribute in Multi-home
  Routing*, June 1996 — the deployment rationale for tagging customer routes
  with `AS:VAL` communities so a provider can apply policy without per-prefix
  configuration. Cited for the *reason* the community vocabulary in §5 is worth
  implementing at all.
- **RFC 8212**, *Default EBGP Route Propagation Behavior without Policies* —
  the modern framing of "no route map configured" (the implicit-deny question
  in §8.1).
- **RFC 4456**, **RFC 5065**, **RFC 8092**, **RFC 2439** — referenced only from
  §12 as future layers.

A note on citation discipline: RFC 4451 is the MED document and RFC 1998 is a
community-attribute document; neither specifies next-hop behaviour. Next hop is
specified in RFC 4271 §5.1.3 and §9.1.2.1, which is what §7 cites. RFC 1997 has
no numbered sections, so it is cited by heading name rather than by a number
that does not exist.
