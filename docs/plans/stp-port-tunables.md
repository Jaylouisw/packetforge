# Plan: three spanning-tree port commands the console refuses, and the election that could already read one of them

Status: forward plan, no code. Measured on `76546d5b`, 2026-11-18. Closes **no** open issue - the queue is
three items (#130, #803 device requests and #1980, a changelog plan) and none is about spanning tree. Scope:
`engine/stp.js`, `engine/simulator.js`, `engine/convergence.js`, `engine/cli.js`, `engine/device.js`,
`docs/CLI.md` and the suites listed under Test strategy. Steps 1-5 change election results, so they can move a
root port in a lab that already exists; that is the point of them and it is called out under Risks.

Distinct from `docs/plans/ospf-elections.md` (which asked why OSPF's `Pri` column was unsettable) and from
`docs/plans/show-view-seams.md` (which asked what `?` answers). This one is about the *port's* three tunables in
802.1D, of which the model has zero, and about the one of them the election already reads and nobody can reach.

## What exists today

**The election reads a per-port cost and no command can write one.** `portCost()` (`engine/stp.js:144`) prefers
`port.cost` when it is set, and falls back to `costForSpeedMbps()` - the Cisco short table, 10 Mb 100 ... 100 Gb 1 -
when it is not. The only production caller never sets it: `computeStp()` builds each port from the cable's
negotiated rate, `let cost = stpLib.costForSpeedMbps(link ? link.speedMbps : null)` (`engine/simulator.js:905`),
halves it per port-channel member and pushes `{ name, cost, to }` (`:910-913`). So `port.cost` is a parameter that
exists for `test/stp-path-cost.test.js:66` and for nothing else - the shape of the OSPF hole in
`docs/plans/ospf-elections.md`, one protocol over.

**Port priority is a constant, and the file says so.** `engine/stp.js:104`: *"Per-port priority
(`spanning-tree port-priority`) is not modelled: every port is at the default 128"*. `comparePortIds()`
(`:120-142`) therefore splits each name into digit and text runs and compares those; there is no priority byte in
front of the number to break a tie with.

**There is no interface-mode door for the word at all.** `spanning-tree` is handled in `_configMode()`
(`engine/cli.js:1122`), and `_ifaceMode()` does not dispatch it - the file records the consequence at
`engine/cli.js:168`: *"an interface block falls through to the config-mode handler for it, exactly as `vlan 20`
does"*. Two tables then produce the refusal an operator sees:

* `STP_UNMODELLED` (`engine/cli.js:642`) lists `portfast`, `edge`, `bpduguard`, `bpdufilter`, `cost`, `guard`,
  `link-type`, `mode`, `mst`, `loopguard`, `root`, `backbonefast`, `uplinkfast`;
* `:1139-1144` answers `% spanning-tree cost is not modelled: this device runs one spanning tree, and its only
  tunable is ...`; the `no` form (`:1295-1300`) answers in the same words. `docs/CLI.md:2930` records the fix that
  produced these sentences (#1493) - correct then, obsolete the moment step 1 lands.

**PortFast has nothing to mark.** `stpTimers()` (`engine/convergence.js:54`) gives every bridge 15 s listening and
15 s learning, and `stpPortStateAt()` (`:240-246`) walks listening -> learning -> forwarding for every port alike.
An edge port is recognised only by having no bridge on the far end (`to: null`, `engine/stp.js:330`), which is a
fact about the cable, not about the configuration.

**The report has three columns and refuses every tail.** `show spanning-tree` prints `Port / Role / State`
(`engine/cli.js:5775-5781`) - no cost, no `Prio.Nbr`, no edge type - and `show spanning-tree <anything>`
(`:5727`) is answered by `showNoTail()`. The numbers the election actually used are computed, stored on
`res.ports[key][name]` as `cost` (`engine/stp.js:347`) and printed nowhere.

**Only the bridge priority survives a save.** `show running-config` emits one spanning-tree line in the device
block (`engine/cli.js:6244`), `toDoc()` carries `config.stpPriority` only when set (`engine/device.js:1492`), and
`fromDoc()` restores that one field (`:1555`), default `null` at `:260`. Per-port tunables would have to be added
to all three or a reloaded lab elects a different root.

The right shape already exists one protocol over: `dev.config.ospf.interfaces[]` holds `{ name, cost, area,
passive }` and is printed inside the interface block (`engine/cli.js:6367-6375`).

## What is missing, ranked

1. **No interface-mode entry point** (`engine/cli.js:168`, `_configMode` at `:1122`). Structural: nothing else can
   land until `spanning-tree <verb>` has an interface branch that reads the verb and the port it was typed on.
2. **`spanning-tree cost` is refused while the election already honours it** (`stp.js:144` vs
   `simulator.js:905`). Cheapest real capability in the file.
3. **`spanning-tree port-priority` has no storage and no byte to compare** (`stp.js:104`, `:120`).
4. **PortFast is refused, so no lab can show a fast link-up** (`convergence.js:240`).
5. **The report hides the cost that decided the tree** (`cli.js:5775`).
6. **Nothing round-trips** (only `:6244` / `device.js:1492` / `:1555`).

## Ordered steps

1. **S - the door, and `spanning-tree cost`.** Add `_stpIfaceCommand(tokens)` on the CLI and call it from
   `_ifaceMode()` before the config fall-through. Accept `spanning-tree cost <1-200000000>` (a real port, and the
   exact spelling `STP_UNMODELLED` refuses today), store `{ name, cost }` in `dev.config.stpPorts`, answer with a
   receipt and support `no spanning-tree cost`. In the same PR, `computeStp()` passes the override through
   (`engine/simulator.js:905`) - `engine/stp.js` needs no change. Acceptance and consumption ship together or the
   command is a lie. Other verbs keep the `not modelled` sentence, now naming the ones still absent.
2. **S - `spanning-tree port-priority <0-224>` in steps of 32.** Port identity becomes `{ priority, name }`;
   `comparePortIds()` compares the priority byte before the name, as `:104` says it should. `DEFAULT 128`.
   Two parallel links to one neighbour are the case that proves it (`test/stp-root-port-tiebreak.test.js:82`).
3. **M - `spanning-tree portfast`.** Store an edge flag per port; `computeStp()` marks the logical port edge in
   `res.ports`; `stpPortStateAt()` (`convergence.js:240`) returns `forwarding` at once for an edge port and states
   the reason. A portfast port facing another bridge still forwards here - BPDU guard is not modelled, and step 3
   must say so in the receipt rather than invent an err-disabled state.
4. **S - the report earns its columns.** `Cost`, `Prio.Nbr` and `Type` (`Edge`/`P2p`/`Shared`) after `State`;
   `show spanning-tree interface <port>` as a one-port detail view instead of `showNoTail`. Update the sample at
   `docs/CLI.md:1849` in the same PR, or the doc teaches the old table.
5. **S - round trip.** Print the three lines inside the interface block (the `ip ospf cost` pattern at
   `cli.js:6372`), add `config.stpPorts` to `toDoc()`/`fromDoc()` (`device.js:1492`, `:1555`), default absent so
   older documents load unchanged.
6. **S - the prose that now contradicts the code.** `docs/CLI.md:2930` records the `not modelled` answer as a fix;
   rewrite it as history, add a "Per-port tunables" subsection beside `:1900`, add the two commands to the table at
   `docs/CLI.md:30` and to the help index (`engine/cli.js:6645` area).
7. **M, needs Jay's approval** - not part of this stream: `spanning-tree vlan <id> priority`, i.e. PVST. The
   model's one-tree answer (`STP_ONE_TREE`, `cli.js:649`) is deliberate and this plan does not move it.

## Risks

* **Elections move.** Steps 1-3 change who roots and who blocks, so any fixture asserting a current tree
  (`test/stp.test.js`, `stp-root-port-tiebreak.test.js`, `stp-shut-port.test.js`) is a review item, not a
  surprise. Defaults must reproduce today's answers exactly: unset cost = speed table, unset priority = 128,
  unset edge = not edge, and that is the first thing to test.
* **Port-channels.** `simulator.js:905-913` derives a bundle's cost from its members and `_logicalPortName()`
  collapses members onto `PoN`. A `cost` typed on `Po1` applies to the logical port; one typed on a member is
  accepted and inert while the bundle exists, and the receipt should say which of the two it landed on
  (`test/stp-port-channel-cost.test.js` is the guard).
* **The board.** `web/faceplate.js:555` (`stpVerdict`) paints from `dev.stp`; a new `forwarding`/`blocking`
  distribution is visible on the canvas, and painting a portfast port green when the tree would block it is the
  #1441 mistake in the other direction.
* **Saved labs.** A document written before step 5 has no `stpPorts`; `fromDoc()` must treat that as "nothing
  configured" rather than as an empty override table.

## Test strategy

* Pure `runStp()` cases: an explicit cost beats the speed table; the priority byte breaks a tie two parallel links
  otherwise decide by name; edge ports stay designated and forwarding.
* **One topology-level test through `Simulator`** - the gap that let the step 1 hole exist: `stp-path-cost.test.js`
  calls `runStp()` directly, so a `computeStp()` that drops `port.cost` passes every test in the suite. Configure
  `spanning-tree cost 19` in a console, run, and assert the root port and the blocking port.
* A CLI suite per command: accepted, refused out of range, refused on a non-stepped priority, `no` restores the
  default, receipt names the port.
* `test/config-roundtrip.test.js` fixture with all three lines; a save -> `fromDoc()` -> election comparison.
* A report test pinning the new header, as `test/stp-port-state.test.js` pins the state words.

## What this closes

No open issue. It closes the gap #1493 documented only as far as the *message*: the console learned to say
`not modelled` honestly and the features themselves were left for later. Steps 1-6 are that later.
