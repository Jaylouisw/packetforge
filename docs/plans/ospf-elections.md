# Plan: the OSPF `Pri` column is a number nothing can set, and the DR election never reads it

Status: forward plan, no code. Measured on `9d852ed8`, 2026-11-18. Closes no open issue - the queue is four
hardware requests (#130, #803, #808, #810), none about OSPF. No step needs Jay's approval: nothing new is
invented, and the Hello field, the column widths and the election rule are all already cited in this repo.

`show ip ospf neighbor` prints a `Pri` column that is `1` for every neighbour in every lab, because
`ip ospf priority` does not exist. The same cell's role - `FULL/DR`, `FULL/BDR` - is decided by comparing the
two router IDs, and the comment says why: "every port here at the default priority 1"
(`engine/simulator.js:1494-1505`). So the column a real box fills from the neighbour's Hello is a constant here,
and the election rule the docs quote - highest priority first, router ID second
(`research/show-ospf-neighbor-state.md:14-17`, Cisco 13688-16) - is only half implemented. The field is already
carried as a number rather than spelled into the table, "so the day the command exists the table reads it"
(`engine/simulator.js:1542-1545`). This plan is that day.

## What exists today

| fact | evidence |
|---|---|
| the setting is refused, by the usage line | `_ipOspf()` `engine/cli.js:2663-2705`; `ip ospf priority 200` in config-if answers `% Usage: ip ospf cost <n> ... ip ospf area <id> ... ip ospf passive` (`:2704`), measured |
| what an interface override can hold | `ov = { name: iface.name }` pushed into `cfg.interfaces` (`engine/cli.js:2664-2670`), then `cost`, `area`, `passive` only |
| how the engine reads an override | `engine/simulator.js:1393-1406` - `cost`, `costSource`, `area`, `passive`, per interface name |
| the role is the router ID and nothing else | `const aDr = aNum > bNum ...` `engine/simulator.js:1506`; the comment at `:1494-1499` names the default priority as the reason |
| the neighbour's priority is a literal | `priority: 1,` `engine/simulator.js:1545`, commented as unmodelled |
| the console already reads the field, with a 1 fallback | `const pri = (n.priority === null ...) ? 1 : n.priority` `engine/cli.js:4649`; the column is `pad('Pri', 3)` and `padStart(3)` (`:4615`, `:4650`) - three columns hold `0`-`255` unchanged |
| a segment has at most two speakers | adjacencies are built from `topo.links` (`engine/simulator.js:1427`), one cable each - so priority is the only variable that can change the outcome today |
| the interface view cannot read it back | `show ip ospf interface` prints Interface / IP Address / Area / Cost / Cost from / Adjacent / Passive (`engine/cli.js:4688-4697`) - no priority anywhere |
| the docs promise the rule and admit the gap | `docs/CLI.md:1449-1462` (the Pri paragraph and the election sentence), `docs/SIMULATION.md:385` (the OSPF Approximate row: "Interface priority ... not modelled") |
| a test asserts the constant | `test/show-ospf.test.js:156-158` - `every(n => n.priority === 1)`, "at the hardware default" |
| the research file names the exact probe that would settle it | `research/show-ospf-neighbor-state.md:72-74` - `ip ospf priority 200` on one end of a two-router segment |
| probe, today | r1 `1.1.1.1` reads `2.2.2.2  1  FULL/DR`, r2 reads `1.1.1.1  1  FULL/BDR` - the lower ID is BDR regardless, and `priority 200` on r1 changes nothing |

## What is missing, ranked

1. **Nothing can raise or lower a priority.** Every lab is stuck at IOS's default, so the first tie-break of the
   election - the one an operator reaches for when a branch router must not become DR - cannot be expressed.
2. **The `Pri` column is a constant, and the code says so.** A printed column that cannot differ is the "presence
   is not correctness" shape this repo has already had to fix: the number looks measured and is not.
3. **The election and the column would disagree the moment the command existed.** `:1506` compares router IDs
   regardless; `:1545` would still say `1` while the neighbour's Hello said `200`. Both have to move together or
   the table contradicts itself.
4. **A value set on a box cannot be read back on that box.** The neighbour table is the *other* end's view; with no
   priority in `show ip ospf interface`, a misconfigured port is only visible from across the cable.
5. Not in this plan: a third speaker, `2WAY/DROTHER` rows, DR stickiness, duplicate router IDs - see below.

## Steps

**1. Console + engine: make the setting exist (S).** In `_ipOspf()` (`engine/cli.js:2663`), one branch beside
`cost`: `priority <0-255>` stored as `ov.priority`, with `no ip ospf priority` deleting it. Range refusal in the
voice the neighbours use (`% Cost must be 1..65535`, `:2680`), naming `0-255` and saying `0` is legal and means
*never eligible* - the one value a reader will otherwise take for a typo. The usage line at `:2704` gains the form.
Publish it: `ospfInterfaces` rows (`engine/simulator.js:1410-1417`) and the `entry.interfaces` objects the
election reads (`:1393-1406`) both carry `priority`, defaulting to `1`. New `test/ospf-priority.test.js`: default
`1`, set on one port only, `256` and `-1` refused, `no` restores `1`, and the setting changes no adjacency, no
route and no `Cost from` cell.

**2. Engine: the election reads it (S).** Replace the router-ID-only comparison at `engine/simulator.js:1500-1510`
with the documented rule on the pair: higher priority is DR; equal priority falls through to the existing
higher-router-ID rule (a no-op for every current lab, which is the guarantee); a speaker at priority `0` is never
DR or BDR, so if both ends are `0` neither is, and each reads the other as `DROTHER` rather than `-` (`-` keeps its
one meaning: no election ran, on a serial port). Then `priority: 1` at `:1545` becomes the peer's own value from
the same `entry.interfaces` entries - the neighbour record stops being a constant and starts being what its Hello
carries. Fold the research probe into `test/show-ospf.test.js`: `priority 200` on the low-ID end flips the pair,
the both-`0` case prints `DROTHER` from both ends, and the default lab stays byte-identical to today's capture.

**3. Console: read the value back on the box that set it (S).** `show ip ospf interface` gains a `Pri` column
(`engine/cli.js:4688-4697`), same name and width as the neighbour table and sourced from the same
`ospfInterfaces` row step 1 publishes, so the two tables cannot disagree. The header comment at `:4525` and the
command summary in `_help()` move with it. Depends on step 1.

**4. Docs and the research file stop saying it is unmodelled (S).** `docs/CLI.md:1449-1462`: the Pri paragraph
describes the field instead of apologising for it, the `ip ospf` command list gains `priority`, and the
before/after transcript the docs use elsewhere is added. `docs/SIMULATION.md:385`: the OSPF row keeps "a third
speaker on one segment ... not modelled" and loses "interface priority". `research/show-ospf-neighbor-state.md`:
probe 3 moves out of "what evidence would settle the remainder" into a citation of the rule, leaving stickiness as
the one still-inferred part. The `no` table's documented count (`docs/CLI.md:3119`, 33 branches) does **not** move:
`NO_FORMS` has no `ip ospf` row and `no ip ospf cost ?` already takes the generic refusal today (probed), which
`priority` inherits.

## Risks

- **This model's election is a snapshot; a real box's is sticky.** A router that was DR keeps the role when a
  higher-priority speaker appears later, while this model recomputes from the topology as it stands - the answer a
  freshly powered lab gives. That is already the documented stance for the router-ID tie-break
  (`research/show-ospf-neighbor-state.md`, "What is inferred") and has to be repeated for priority, not silently
  reinterpreted.
- **`DROTHER` and `-` will be confused.** One means an election ran and this speaker lost; the other means no
  election ran at all. The cell is the *neighbour's* role, so the both-`0` case must be asserted from both ends of
  the cable or the output can look right from one side only.
- **Roles are display-only here and must stay that way.** `ospfInterfaces[].adjacent` is set from neighbour-list
  membership (`engine/simulator.js:1551`) and the link's `cost: 10` (`:1513`) is untouched, so no route can
  move. The full suite is the evidence: if any `show ip route` line or `[110/n]` metric changes for a default lab,
  the election change reached further than the role cell.
- **Additive payload.** `ospfInterfaces[].priority` is a new field beside a neighbour field that already exists
  (both published by `server/index.js`), nothing in `web/app.js` reads `ospfInterfaces` yet, and no column reflows
  the way the Area width once did (`engine/cli.js:4683-4688`) - so the API shape changes additively by construction.

## Test strategy

`test/ospf-priority.test.js` for the command surface (default, set, range, reset, scope, no-op on routes);
`test/show-ospf.test.js` for the two transcript cases and the unchanged default lab - it already asserts the
console against `dev.ospfNeighbors` and `dev.ospfInterfaces`, so a console printing a priority the engine does not
carry fails there first. `node scripts/syntax-check.js`, then the full `npm test`: `engine/cli.js` and
`engine/simulator.js` are two of the hottest files in the repo. Pasteability: the acknowledgement for
`ip ospf priority 200` must be typeable back into the session that printed it, and `no ip ospf priority` must say
what it restored.

## Deliberately left out

- **A third speaker on one segment.** Adjacency needs a direct cable (`engine/simulator.js:1427`), so a shared LAN
  through a switch forms no adjacency at all; `DROTHER` there and the `2WAY` state need broadcast-domain adjacency
  first - a different and much larger plan, and one that should carry Jay's explicit approval before it is written.
- **DR stickiness and boot order.** There is no clock and no power-on order, so "the DR that was already there
  keeps it" is not expressible without a run-order decision. Same reason `show ip ospf interface` would still print
  no `State DR` line in step 3.
- **`ip ospf network point-to-point` / `broadcast`.** Its own plan: it decides *whether* an election runs, which is
  upstream of this one, and the research file already lists it as unresolved.
- **Duplicate router-ID diagnosis.** The tie-break falls back to device id to stay stable
  (`engine/simulator.js:1503-1506`); priority does not change that trade-off and this plan should not appear to fix
  it.
- **`ip ospf hello-interval`.** Separate work with its own research file (`research/ospf-hello-interval-match.md`),
  whose mismatch refusal is the model this plan's range refusal copies.
