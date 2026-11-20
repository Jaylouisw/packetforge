# Plan: `show ip bgp` answers seven questions with one table, because the argument is dropped

Status: forward plan; step 2's **refusal half** has landed (a word the view cannot use is refused, not dropped —
see the change note at the end of this file). Measured on `f44b8c9`, 2026-11-19. Closes no open issue - the queue holds one
hardware request (#130, UDW-PRO), unrelated. No step needs Jay's approval: every step narrows an existing
command to the view its own words already name. Nothing new is configured.

`show ip bgp` is one door for every spelling - `summary`, `neighbors`, `regexp …`, a prefix - and
`_showBgp(args)` (`engine/cli.js:5237`) never reads `args`. The dispatch hands it the tail
(`engine/cli.js:6162`), the body never touches it, so `show ip bgp summary`, `show ip bgp neighbors`,
`show ip bgp 10.0.0.0/24` and `show ip bgp bogus` print the same bytes as the bare command. The repo already
wrote this down and then built on it: "One door, `_showBgp()` … serves `show ip bgp`, `show ip bgp summary`,
`show ip bgp neighbors` and any other tail" (`research/bgp-not-active-refusal.md:13`). That sentence was
written about the *refusal* one door makes possible; the populated case is where it stops being a feature.

Measured, one eBGP session between two ASR 1001-X (r1 10.0.0.1/65001, r2 10.0.0.2/65002), settled lab:

```
show ip bgp                  -> BGP router identifier 10.0.0.1, local AS number 65001
                                Neighbor V AS State Reason / 10.0.0.2 4 65002 Established eBGP
                                1 of 1 neighbour(s) established
                                0 prefix(es) installed from BGP (1 more received, not installed: ...)
                                Network Next Hop Metric LocPrf Weight Path Session / 10.0.0.0/24 ...
show ip bgp summary          -> byte-identical to the above
show ip bgp neighbors        -> byte-identical
show ip bgp neighbors 10.0.0.2 -> byte-identical
show ip bgp 10.0.0.0/24      -> byte-identical
show ip bgp regexp ^65002    -> byte-identical
show ip bgp bogus            -> byte-identical  (a typo answered with a full table)
```

## What exists today

| fact | evidence |
|---|---|
| the handler takes a tail and never reads it | `_showBgp(args)` `engine/cli.js:5237`; inside its 99-line body `args` appears only in the signature (measured) |
| the tail is passed in | `this._showBgp(tokens.slice(2))` `engine/cli.js:6162` |
| the same door is documented | `research/bgp-not-active-refusal.md:13`; `docs/CLI.md:2644` ("`show ip bgp`, `show ip bgp summary` and every narrowed form") |
| its siblings *do* read theirs | `_showOspf(args)` `engine/cli.js:4994` reads `args[0]` at `:5002` and resolves a port name; `_showDhcp` `:4785`; `_showDns` `:4688` |
| a refusal helper already exists | `showNoTail()` `engine/cli.js:595`, used for `show version` `:5851`, `show lldp` `:6198`, `show lldp neighbors` `:6201` |
| the header printed is the *summary* header | `engine/cli.js:5262` - `BGP router identifier …, local AS number …`; a box's `show ip bgp` opens with `BGP table version is …, local router ID is …` ([Cisco IOS BGP Command Reference, `show ip bgp` field table](https://www.cisco.com/c/en/us/td/docs/ios/iproute_bgp/command/reference/irg_book/irg_bgp5.html)) |
| a box's `show ip bgp` is the RIB, not a neighbour list | same reference: fields are BGP table version, local router ID, Origin codes, then Network / Next Hop / Metric / LocPrf / Weight / Path |
| the prefix rows are already built | `cells` at `engine/cli.js:5297-5322`, with the LocPrf rule from #1269 |
| "installed" is already data, not a recount | `installed === false` + `shadowedBy` `engine/device.js:1426-1441` |
| a neighbour row carries no counters or timers | `dev.bgpNeighbors` `engine/simulator.js:1882-1890` - `address, remoteAs, session, state, established, code, reason`, nothing else |
| the walk that could supply counts exists | `ESTABLISHMENT` four steps `engine/bgp.js:683-688`, `establishSession()` `:695` returning `events[]` |
| hold time is already validated and stored | `parseHoldTime()` `engine/bgp.js:98`, `DEFAULT_HOLD_TIME = 180` `:57` |
| one clock, and it can be `Infinity` | `setRunTime(atMs)` `engine/simulator.js:442` (`runAtMs`), default `Infinity` = converged |
| the docs merge the two views into one row | `docs/CLI.md:35` - "BGP neighbours with their state and reason, and the prefixes installed" |
| the help line merges them too | `engine/cli.js:7478` - `show ip bgp [summary]` |
| a test pins the shared door (correctly, for the off case) | `test/bgp-not-active.test.js:49` types four views and expects `% BGP not active` from each |
| ten suites read this command | `test/bgp-*.test.js`, `test/route-selection.test.js`, `test/show-ip-spellings.test.js:120`, `test/help-completeness.test.js` (15 call sites; one reads the `N of M neighbour(s) established` line) |

## What is missing, ranked

1. **The argument is dropped.** A typo (`show ip bgp bogus`) is answered with data. Every other show door in
   this console refuses a tail it does not implement, and this one cannot tell a typo from a view.
2. **`show ip bgp summary` and `show ip bgp` are the same bytes.** On a box they are different views - the RIB
   and the neighbour table - and the docs' single table row (`docs/CLI.md:35`) is the admission that they were
   merged rather than modelled.
3. **There is no per-neighbour view.** `neighbors <ip>` prints the summary, so hold time, the state the walk
   died in, and per-peer counts are unreachable - even though `bgpNeighbors` holds the state and `bgp.js`
   holds the walk that produced it.
4. **No valid/best marker.** The prefix table prints bare rows, so a BGP route that lost to a better one
   (`installed === false`, `shadowedBy` `engine/device.js:1426`) reads exactly like the installed one. The
   distinction is already computed and only the marker is missing.
5. **No per-prefix detail and no `regexp` filter.** Both are spellings the door claims by existing.
6. **Nothing to print even if the views existed.** No message counters, no session start instant, no
   `State/PfxRcd` per peer.

## Ordered steps

1. **S - capture the four views before writing any of them.** New `research/bgp-show-views.md`: what a box
   prints for `show ip bgp` (banner, status-code line, `*>` markers, Origin-codes legend), for
   `show ip bgp summary` (column header and what each cell means), for `show ip bgp neighbors <ip>` (block
   order: neighbour line, remote AS, state, last read/write, hold time, capabilities, message stats), and for
   a tail that is not a view. No code, no `docs/CLI.md`. Every literal line in steps 2-6 must quote this file;
   the house rule is that no vendor sentence ships without a capture behind it.
2. **S - read the argument.** *(Half landed: `args` is now read, `summary` is the only word accepted, every other
   word is refused in `showNoTail()` shape and `neighbors` is answered as a view this console has no form of —
   `test/show-ip-bgp-argument-refusal.test.js`, `research/show-ip-bgp-argument-refusal.md`. The dispatch to real
   per-view functions is steps 3-6 and is still open.)* `_showBgp(args)` dispatches on `args[0]`: `''` and `summary` reach their own
   functions, `neighbors`/`neighbour`/`neighbors <ip>`, `regexp <re>` and a prefix token reach theirs, and
   anything else is refused with the sentence the capture records (the `showNoTail()` shape at
   `engine/cli.js:595` if the capture shows the "takes no word" refusal). Guard order is unchanged: the
   `% BGP not active` check at `:5255` still runs first, so `test/bgp-not-active.test.js:49` stays green.
3. **M - `show ip bgp` becomes the RIB.** Banner and legend from step 1, `*>` from `installed`/`shadowedBy`,
   the Origin-codes line, and the prefix table only - the neighbour table moves to `summary`. Three call sites
   read the `N of M neighbour(s) established` line from `show ip bgp`; they move to `summary` in the same PR,
   or the line is kept in both and the test says so. `docs/CLI.md:35` splits into two rows and the
   "Reading `show ip bgp`" sample (`docs/CLI.md:2604`) is re-cut from the new output.
4. **M - `show ip bgp summary`.** The neighbour table that exists today, plus the columns the capture shows and
   the data supports without new engine state: `State/PfxRcd` counted per peer from `dev.bgpRoutes`. Column
   widths from the capture, not guessed. `docs/CLI.md` row two lands here, in the same PR.
5. **M - `show ip bgp neighbors [<ip>]`.** Per-peer block in the captured order; hold time from
   `config.bgp.neighbors` (`validatePeer()` `engine/bgp.js:142`), message counts derived from the walk's
   `events[]` and labelled as the walk's, and `Up/Down` printed as `never` where the session never came up.
   An elapsed column needs a session start instant the engine does not keep: `runAtMs` (`:442`) is the only
   clock and is `Infinity` on a settled lab, so either stamp the start in `computeBgp()` or ship the column as
   `never` and say so - the second is the smaller PR.
6. **S - `show ip bgp <prefix>` and `regexp <re>`.** Filter the RIB rows built in step 3; `regexp` supports
   what `asSegments()`/`asPathLength()` (`engine/bgp.js:290-310`) can evaluate and refuses the rest with the
   capture's sentence, rather than silently matching nothing.

## Risks and test strategy

* **Inventing a vendor line is the failure mode here.** Every literal string in steps 2-6 comes from
  `research/bgp-show-views.md`; a line with no capture does not ship. If a capture cannot be found for
  `regexp`, step 6 refuses the form instead of guessing it.
* **The regression that would have caught this defect is "two views, two answers".** One test asserts the
  seven spellings do not all print identical bytes, and pairs each view with one fact only it can show
  (`summary` has the peer row; `show ip bgp` has `*>`; `neighbors 10.0.0.2` has the hold time).
* **Ten suites read `show ip bgp`** (15 call sites); `test/bgp-session-link-state.test.js:51` reads the
  established count from it. Step 3 either keeps that line in both views or edits that call site - both are
  fine, silently dropping the line is not.
* **`docs/CLI.md` is executable**: `test/docs-show-commands.test.js` types every `show …` code span, so a doc
  row added before its handler fails the suite. Docs and handler land in the same PR, per step.
* **Two views, one banner.** The `BGP router identifier … local AS number …` line at `:5262` is the summary's
  banner; step 3 must not print it at the top of the RIB view "for consistency".
* **Left alone on purpose:** `docs/SIMULATION.md:412` still says the FSM "is never fed", which the walk
  (`engine/bgp.js:695`) contradicts. Real drift, different plan (`doc-citations.md` territory).

## Deliberately left out

* **Policy.** `LOCAL_PREF`, MED, communities, route-maps: `docs/BGP-POLICY.md` is the design document for
  those, and a show view that printed them today would print constants.
* **`neighbor … shutdown` / `activate` / `maximum-prefix`** - configuration, not a view; each is its own
  command with its own refusal sentence.
* **A BGP RIB in the web inspector.** The console is the surface this plan repairs; the UI table is a
  separate question about the same data.
* **Timers that expire.** Hold/keepalive counting down needs a scheduler the engine does not have; `show ip
  ospf neighbor`'s `Dead Time` is the precedent, and it is a simulator-wide question, not a show-view one.

## Closes

Nothing. The open queue is #130 (device request, UDW-PRO) and this plan is about a console view.

## Change log

* **Step 2, refusal half (2026-11-20).** `_showBgp(args)` now reads its tail. `summary` is the only word it
  accepts; any other word is refused with `% show ip bgp does not take "<words>": …`, naming the Network column as
  where a single prefix is read, and `show ip bgp summary <word>` refuses the same way. `neighbors`,
  `neighbour(s)` and anything after them answer `has no detail view here` instead — a box has that view and this
  console has no detail block, so "does not take" would be the wrong sentence. The `% BGP not active` guard still
  runs first, so `test/bgp-not-active.test.js` is unchanged. `docs/CLI.md`'s refusal list names both spellings.
  Evidence and the one unresolved ordering question: `research/show-ip-bgp-argument-refusal.md`.
