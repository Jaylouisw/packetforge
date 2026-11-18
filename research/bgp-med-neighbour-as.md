# MED, and the AS it is allowed to be compared across

**Question (one, narrow).** When two paths to the same prefix tie on weight, local preference, local
origination, AS_PATH length and origin, but were learned from **different neighbouring ASes** and carry
**different MEDs**, does a real BGP speaker separate them on MED - and what did PacketForge do?

**Verdict: known, and the engine was the half that disagreed.** MED is comparable only between routes
learned from the same neighbouring AS. `engine/bgp.js` compared it unconditionally, and its own header
called that "a deliberate simplification: real BGP only compares MED between paths learned from the same
neighbour AS". The effect is a table that installs a route a box would not: the peer in the "other" AS
with the lower MED won, where a box ties those paths at step 6 and goes on to *eBGP over iBGP*, then the
advertising router ID.

## The standard states the restriction, the neighbour, and the exception

RFC 4271 §9.1.2.2, the decision function's step (c), with the pseudo-code that follows it:

> c) Remove from consideration routes with less-preferred MULTI_EXIT_DISC attributes. MULTI_EXIT_DISC is
> only comparable between routes learned from the same neighboring AS (the neighboring AS is determined
> from the AS_PATH attribute). Routes that do not have the MULTI_EXIT_DISC attribute are considered to
> have the lowest possible MULTI_EXIT_DISC value.
>
> ```
> for m = all routes still under consideration
>     for n = all routes still under consideration
>         if (neighborAS(m) == neighborAS(n)) and (MED(n) < MED(m))
>             remove route m from consideration
> ```
>
> Similarly, neighborAS(n) is a function that returns the neighbor AS from which the route was received.
> If the route is learned via IBGP, and the other IBGP speaker didn't originate the route, it is the
> neighbor AS from which the other IBGP speaker learned the route. If the route is learned via IBGP, and
> the other IBGP speaker either (a) originated the route, or (b) created the route by aggregation and the
> AS_PATH attribute of the aggregate route is either empty or begins with an AS_SET, it is the local AS.

* <https://www.rfc-editor.org/rfc/rfc4271.txt> (§9.1.2.2, pages 80-81)

Three things follow from that paragraph, and the engine needed all three:

1. the test is on the neighbouring AS, keyed off the AS_PATH;
2. an eBGP speaker prepends its own AS when it advertises (§5.1.2(b)), so for a learned eBGP route the
   leftmost AS of the AS_PATH **is** the neighbouring AS - which is the only form this engine can read;
3. a path that names no first AS - empty, or AS_SET-leading - is the **local** AS, and two candidates on
   one box share their local AS. So "no AS named" does not make two paths incomparable.

## The vendor says the same thing in AS_PATH terms

Cisco, *Select BGP Best-path Algorithm* (document ID 13753), step 6:

> **Note**: Be aware of these items:
>
> - This comparison only occurs if the first (the neighboring) AS is the same in the two paths. Any
>   confederation sub-ASs are ignored. In other words, MEDs are compared only if the first AS in the
>   AS_SEQUENCE is the same for multiple paths. Any AS_CONFED_SEQUENCE that precedes is ignored.
> - If **bgp always-compare-med** is enabled, MEDs are compared for all paths.

* <https://www.cisco.com/c/en/us/support/docs/ip/border-gateway-protocol-bgp/13753-25.html> (step 6)

`docs/BGP-POLICY.md` already carried this as rules MED-3 (same neighbouring AS only) and MED-4 (the
neighbouring AS is where the route entered the AS, not the iBGP peer that relayed it, and empty or
AS_SET-leading is the local AS). The document was right and the code was not, which is why this was a
fidelity fix rather than a design change.

## What changed

`engine/bgp.js` gains `neighbourAs(path)` - the leftmost AS of the AS_PATH when it is a number (or a
string of digits), `null` when the path states none (empty AS_PATH, or a leading AS_SET, which names a
set rather than the one AS the route entered from) - and `medComparable(a, b)`, which is false only when
**both** paths name a neighbouring AS and the two differ. Step 6 of `comparePaths()` is now guarded by
it, so two paths from different neighbours fall through to eBGP-over-iBGP and then the router ID, exactly
as the RFC's `if (neighborAS(m) == neighborAS(n))` skips the comparison.

`test/bgp-med-neighbour-as.test.js` holds 22 checks: the same-AS behaviour that must not regress (lower
MED still wins, either argument order, and for a deeper path through the same neighbour), the
different-AS case proved by a *higher* MED winning when its path has the lower router ID (and the other
path winning when the IDs are swapped - so the outcome is the ID's, not the MED's), the null cases (a
locally originated path still loses to a learned one, an AS_SET-leading path stays comparable so its MED
still decides), the string-vs-number AS spelling, and two labs: a pre-existing fact this rule depends on
- the AS_PATH on an installed eBGP route begins with the peer's AS (`asPath[0]` and `peerAs` both read
it) - and that two peers in one AS still install one route naming that shared AS.

## What is inferred, not published

* **An AS_SET anywhere but the front is not a neighbouring AS.** The RFC names the case only for a path
  that *begins* with an AS_SET, and only for an aggregate. Reading the leading segment alone is the same
  rule; an AS_SET behind a sequence cannot be the first AS by construction.
* **A leading AS_SET on an eBGP-learned path.** Here the sender's own AS is prepended, so a leading
  AS_SET only appears on iBGP-learned aggregates - the case the RFC spells out. The helper applies the
  null rule to any path shape, which is the same answer for the only shape that occurs.

## What remains unresolved

* **`bgp always-compare-med` is not modelled** (MED-5 in `docs/BGP-POLICY.md`). The default - the
  restriction - is what this engine now does, and there is no config verb to lift it. A lab that turns it
  on cannot be built yet.
* **`bgp deterministic-med` is not modelled.** It orders paths within one neighbouring AS so MED
  comparison cannot depend on the order routes arrived; this engine's candidate lists are rebuilt from
  scratch on every round, so there is no arrival order for it to stabilise.
* **`bestPath()` still sorts.** The RFC's procedure is "remove from consideration", and a comparator
  carrying this MED rule is not a total order, so a list of three or more candidates is not guaranteed to
  yield the pipeline's winner. `docs/BGP-POLICY.md` §4.5 specifies the elimination pipeline that would
  fix it; for two candidates - what every prefix in this model holds per speaker - the two agree.
* **MED is still compared unqualified where it is re-advertised.** MED-6 (an inherited MED must not be
  sent to another neighbouring AS) is unmodelled: there is one MED field and no `medSource`, so a route
  relayed into another AS carries the MED it arrived with.
* **What a box prints when MED is the deciding attribute** (`show ip bgp` marking a path with `(med)`)
  is not modelled; this console's `show ip bgp` prints no per-path annotation column.

What would settle the last two: a `show ip bgp <prefix>` capture from a two-provider lab where the
inherited MED is visible on the re-advertised path, and one showing the `(med)` marker in the path
selection note column.
