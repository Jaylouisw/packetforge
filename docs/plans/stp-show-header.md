# Plan: `show spanning-tree`'s header - the Root ID and Bridge ID blocks a Catalyst prints

Status: forward plan, no code. Measured on `4afe9e5b`, 2026-11-28. Closes **#1713**. Scope:
`engine/stp.js`, `engine/simulator.js`, `engine/cli.js`, `engine/convergence.js`, `docs/CLI.md`, and the
suites named under Test strategy. The port table under the header is **not** touched: its columns are
`docs/plans/stp-port-tunables.md` step 4, which quotes the same transcript - whichever of the two lands
second rebases the sample.

## What exists today

**One sentence stands where the block is.** `show spanning-tree` is answered at `engine/cli.js:7979`; every
tail is refused (`:7981`), so `show spanning-tree vlan 10` is not a view. A router returns early with the
box's own `No spanning tree instance exists.` (`:8023`). A bridge then prints:

```
Spanning tree enabled protocol ieee
  Bridge priority 32768 (this bridge is the root), root bridge s3 priority 32768
Interface           Role Sts Cost      Prio.Nbr Type
------------------- ---- --- --------- -------- -------
1/1/1               Desg FWD 4         128.1    P2p
```

The second line is `out.push()` at `engine/cli.js:8039-8040`, built from `this.sim.stpResult.root` (`:8030`)
and `mine` (`:8011-8012`); with no election behind it, `:8042` prints `Bridge priority 32768, root bridge not
measured (no election has run)`. Measured on a three-switch triangle and on a lone bridge, this build.

**The block's fields are mostly already computed.** `runStp()` returns `root: { key, priority, mac }`
(`engine/stp.js:355-365`) and formats the root's address through `net.formatMac()` - the function `show ip arp`
and the MAC table already use (`engine/net.js:146`; it prints `02:00:00:00:00:01` as `0200.0000.0001`). The
box's **own** bridge MAC is derived in `computeStp()` (`engine/simulator.js:952-957`) but kept only in the
throwaway `bridges` array, so `dev.stp` (`:975`) has no address. The root port is `dev.stp.roles[name] ===
'root'` and its cost is `dev.stp.costs[name]`, written at `:985-990`.

**Two fields do not exist anywhere.** The root path cost is the Dijkstra `dist` map (`engine/stp.js:231`),
which is dropped when `runStp()` returns; the Root ID block's `Cost`/`Port` is the one thing a non-root
cannot be asked for today. And the header's `Port` is a port *index*, which `portOrdinals()`
(`engine/stp.js:456`) already derives for the table's `Prio.Nbr` cell (`engine/cli.js:8114`).

**The timers are in force but unprintable.** 802.1D's 2 / 20 / 15 s are `engine/convergence.js:30-32`, read
by `stpTimers()` (`:54-65`) - which returns forward delay and max age but not hello - and nothing can set
them: `spanning-tree hello-time` is refused by the not-modelled branch (`engine/cli.js:1686`). `Aging Time`
is the CAM ageing, not an STP timer (`research/show-spanning-tree-aging-time.md`: a 6500 prints `Max Age 20`
and `Aging Time 15` in one block; the range matches `dot1dTpAgingTime`), and the model already ages MACs by
`MAC_AGE_MS = 300000` (`engine/device.js:6`, exported at `:1931`).

**The docs reproduce the sentence and then misattribute the header.** `docs/CLI.md:2671-2678` prints it as
the sample, and `:2689` says "the header, the rule under it and the column positions are a machine-recorded
Catalyst capture's" - true of the port table, false of the two lines above it. `:31` describes the view as
printing "the bridge priority and the elected root". The capture this console already copies is
ntc-templates `cisco_ios_show_spanning_tree.raw`, whose block is:

```
VLAN0001
  Spanning tree enabled protocol ieee
  Root ID    Priority    32769
             Address     fa16.3e57.336f
             Cost        8
             Port        4 (GigabitEthernet0/3)
             Hello Time   2 sec  Max Age 20 sec  Forward Delay 15 sec

  Bridge ID  Priority    32769  (priority 32768 sys-id-ext 1)
             Address     fa16.3e77.b50c
             Hello Time   2 sec  Max Age 20 sec  Forward Delay 15 sec
             Aging Time  300 sec
```

## What is missing, ranked

1. **No address.** The view is about an election and prints no bridge ID: neither the elected root's nor the
   box's own. `Address` is the field that makes two switches' answers comparable.
2. **No root path cost and no root port.** A non-root cannot say what it pays or which port it pays it on;
   `runStp()` throws both away.
3. **No timers, no ageing.** `Hello Time / Max Age / Forward Delay` and `Aging Time` are the numbers that tell
   a reader whether the tree is a factory one.
4. **The `Bridge priority` label.** No box prints it; the priority appears twice instead, under `Root ID` and
   `Bridge ID`, with the `sys-id-ext` arithmetic the capture shows (4096 configured prints 4097).
5. **Prose and the missing note.** `docs/CLI.md:2689` and the issue's citation of
   `research/show-spanning-tree-header-block.md` - a file that is not on `main` (the material that is, is
   `research/show-spanning-tree-aging-time.md`).

## Ordered steps

1. **S - `runStp()` returns what it already computed.** Add `bridges: { [key]: { priority, mac, rootCost,
   rootPort } }` to the result (`engine/stp.js:355`), read from `dist` (`:231`) and `rootPortOf` (`:266`);
   root cost 0 and root port `null` for the root itself. Additive: no caller changes, no output changes.
   Unit tests only.
2. **S - the Bridge ID block.** Print it after the existing sentence, ending with the capture's blank line:
   `Bridge ID  Priority    <priority + 1>  (priority <priority> sys-id-ext 1)`, `Address` from
   `stpResult.bridges[dev.id].mac` through `net.formatMac()`, then `Hello Time   2 sec  Max Age 20 sec
   Forward Delay 15 sec` from `stpTimers()` (add `helloSec` to its return - the constant exists at
   `convergence.js:32` and is read by nothing), then `Aging Time  300 sec` from `MAC_AGE_MS / 1000`. Update
   the sample at `docs/CLI.md:2671-2678` for the added block only - it is already behind the table (no
   `Prio.Nbr`), which `stp-port-tunables.md` owns, so this step touches only the lines above `Interface`.
3. **M - the Root ID block replaces the sentence.** Root: `Root ID    Priority    <p+1>`, `Address`, then
   `This bridge is the root` - the words the sentence already carries. Non-root: the root's address, then
   `Cost <rootCost>` and `Port <ordinal> (<port name>)`, the ordinal from `portOrdinals()` and the name in the
   console's own spelling (a bundle root port prints `Port - (Po1)`, the `-` rule `Prio.Nbr` already uses).
   `Fixes #1713` on this PR. **This step removes a tested property** (below), so it needs Jay's word.
4. **S - the evidence and the prose.** Write the note #1713 cites
   (`research/show-spanning-tree-header-block.md`) from the ntc capture and
   `research/show-spanning-tree-aging-time.md`, or fix the citation; rewrite `docs/CLI.md:2689-2694` so only
   the port table is called the capture's, and correct `:31`.

## Risks

* **The root loses its lab name.** `test/report-sweep.test.js:114-158` asserts `root bridge sw1`, `root bridge
  <lab id>` and "a configured hostname beats the id" - the property that a reader can act on who won. A box
  prints only the address, so step 3 drops the hostname and those four assertions must become address
  comparisons (`stpResult.root.mac` equals the `Address` line, and the box's own `Address` equals its own
  MAC). This is the plan's one judgement call: faithful output over the convenience label. If Jay wants the
  name back, the place is `show spanning-tree detail` (refused today, `docs/CLI.md:2687`), not a label no box
  prints.
* **4096 prints as 4097.** The `sys-id-ext 1` arithmetic is the capture's, and `test/stp-priority.test.js`
  (`:166`, `:170`) and `test/no-command-touches-only-what-it-names.test.js:65` match `Bridge priority 4096`
  today. The set receipt ("Bridge priority set to 4096") stays as it is; the block's parenthetical is what
  explains the difference, and a test must pin both numbers in one line.
* **Keep the unmeasured branches.** `root bridge not measured (no election has run)` (`cli.js:8042`) and the
  router's one line are tested (`test/stp-priority.test.js:173`, `test/stp-no-instance-wording.test.js:56`);
  the Bridge ID block may be printed without an election (the box's identity needs none), but the Root ID
  block must not be invented for it.
* **A `lag-N` root port has no index.** `portOrdinals()` deliberately declines bundles, so the `Port` line
  keeps the table's `-` rather than borrow a member's number.

## Test strategy

* A new `test/stp-show-header.test.js`, the capture as the fixture: a lone bridge is its own root with
  `This bridge is the root`; a triangle's non-root prints the root's dotted address, `Cost` equal to the sum
  of the two 4s the table charges, and `Port 2 (1/1/2)` beside `Root` in the table; `spanning-tree priority
  4096` yields `Priority 4097  (priority 4096 sys-id-ext 1)`; `Aging Time  300 sec`; no `undefined`; one blank
  line before `Interface`.
* Pure `runStp()` cases: `bridges[key].rootCost` is 0 for the root and the Dijkstra distance otherwise;
  `rootPort` names the port the port map marks `root`; `mac` is the bridge's own, not the root's, on every
  entry.
* Regression: the router's one line, the unmeasured sentence, the `detail` refusal, and the table's column
  positions (`test/l2.test.js:205`, `test/stp-port-state.test.js`) all unchanged.
* The four suites named under Risks, updated in step 3, plus the doc sample in the same PR.

## What this closes

**#1713.** It leaves one token of that issue's block unprinted: the `VLAN0001` instance label. This model
computes one tree for the whole box (`STP_ONE_TREE`, `engine/cli.js:1070`) and refuses `show spanning-tree
vlan` (`:7981`), so the label would name an instance the tree does not follow; PVST is
`docs/plans/stp-port-tunables.md` step 7 and needs Jay's approval. Also untouched: `show spanning-tree
detail`, the table's columns, and anything configurable - there is still no `spanning-tree hello-time`.
