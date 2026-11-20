# Plan: a VRRP master keeps a gateway it can no longer serve

Status: forward plan, no code. Measured on `8b94f987`, 2026-11-20, with a probe lab built on
`Topology`/`Simulator`/`runCommands`. Closes **no** open issue — the queue holds #130 (a Ubiquiti
device request) and #1980 (an open changelog plan, PR #1980), and neither is about first-hop
redundancy. Steps 1-5 extend what exists; only step 5 adds a command word. Nothing here invents a
protocol — `docs/SIMULATION.md:383` already names the gap this plan closes.

## What exists today

| fact | evidence |
|---|---|
| the election is a pure function over a snapshot | `electMaster()` `engine/vrrp.js:379`, `candidateList()` `:334`, `effectivePriority()` `:373`; the header `:1-7` states the design: no advertisements, no timers, no held state |
| a candidate's liveness is its own interface, and nothing else | `up: ifaceName.enabled !== false && !!(ifaceName.ip)` `engine/simulator.js:1080` — a second port, a cable, a route are all invisible to it |
| the election has exactly two call sites | the packet path `Simulator.ping()` `engine/simulator.js:617`, and `_refreshControlPlane()` `engine/cli.js:5848-5860`, which every `show` calls (`:5920`) |
| a link change does **not** run it | `setLinkState()` `engine/simulator.js:498-556` rebuilds the tree, flushes MAC tables and re-bases the schedule, then returns |
| the config vocabulary is five words | `_vrrpIfaceCommand()` `engine/cli.js:3875-3951`: `ip`, `priority`, `preempt`, `advertise`, `authentication`; the `no` forms at `:2255-2299` |
| the view has seven columns and no tail | `_showVrrp()` `engine/cli.js:3966-4048`; `show vrrp <group>` is refused by `showNoTail()` `:6409-6413` |
| a group survives a save | `toDoc()` deep-copies `config.vrrp` `engine/device.js:1595-1596`, `fromDoc()` restores it `:1675`, and `show running-config` prints it inside the interface block `engine/cli.js:7257-7266` |
| the timer arithmetic exists, and only for skew | `vrrpTimers()` `engine/convergence.js:83-96` (Master_Down = 3 x advert + skew) |

Measured, on a lab of `generic-*` devices — PC1 `10.0.0.50` and SW1 fronting R1 `10.0.0.1/24`
(VRRP 10, priority 150) and R2 `10.0.0.2/24` (priority 100), both routers also cabled through SW2 to
a server `10.9.9.9`:

```
                        ping SRV from PC1   claims (R1/R2)   show vrrp
before cutting R1 Gi0/1 2/2 succeeded       1 / 0            R1 Master 150, R2 Backup
after  cutting R1 Gi0/1 0/2 "link down      1 / 0            R1 Master 150, R2 Backup
                        (dropped by d1)"                     (master 10.0.0.1)
```

R2 holds a connected route to `10.9.9.0/24` and is one election away from serving the subnet, and
nothing asks it to. The same probe shows the second finding:

```
                        claims (R1/R2)
after a ping             1 / 0
after shutdown on R1's Gi0/0 (the master, and the group's only port)
                         1 / 0   <- the claim did not move until the next ping re-ran the election
```

## What is missing or weak, ranked

1. **Nothing tracks the wire behind the group.** A master whose only uplink dies keeps priority 150
   and the VIP; every host on the subnet black-holes while a healthy backup sits at 100. This is the
   classic reason `vrrp <vrid> track <interface>` exists, and the model has no word for it.
2. **A topology change does not re-elect.** Even the documented failover (`SIMULATION.md:380`,
   `test/vrrp-in-path.test.js`) leaves `device.vrrpClaims` on the old master until something calls
   `computeVrrp()` again — a ping, or a `show`. The canvas and any non-ping packet path see the
   previous topology's claim.
3. **The view cannot say why a priority is what it is.** `show vrrp` prints the number the group voted
   with, and no line explains a decrement, because none can exist yet.
4. **Preemption is all-or-nothing.** `preempt` is a boolean (`normalizeGroup()` `engine/vrrp.js:257`,
   default true), so a router that powers back up takes the VIP the moment it can — the flapping case
   `preempt delay minimum` exists for.
5. **Nothing detects a silent master.** An interface that stays up while advertisements stop is not a
   state the model has; this is deliberately out of scope below, because it fights `vrrp.js:1-7`.

## Ordered steps

1. **Re-elect when the wire moves** (S). One choke point: `Simulator.markTopologyChange()`
   (`engine/simulator.js:488-496`) gains `this.computeVrrp()`, and `setLinkState()` calls it instead of
   `this.topo.markChange(atMs)` directly (`:544`). Both operator doors reach that method:
   the `link <id> down` command (`engine/cli.js:4619`) and `shutdown` / `no shutdown` through
   `_controlPlaneChanged()` (`:5675-5679`). Test: cut the master's only cable, assert the claim moves
   and the takeover emits its `garp` event; shut a master port and assert the same without a ping in
   between. Must not disturb `_converged()` — a takeover still waits for skew, as it should.
2. **`vrrp <vrid> track <interface> [decrement <1-253>]`** (M). Store `track: [{ iface, decrement }]`
   on the group (`decrement` default 10); validate in `validateGroup()` `engine/vrrp.js:142` —
   interface must exist, cannot be the group's own interface, decrement 1-253; apply in
   `computeVrrp()` `engine/simulator.js:1080` by lowering the candidate's priority, floor 1, owner 255
   unaffected. An unplugged tracked port is exactly the state the feature reports, so it is accepted
   and simply costs its decrement.
3. **`show vrrp` says what the priority paid for** (S). A `Track` cell when a group has one, and a
   note naming the port and the decrement in force (`% VRRP group 10: priority 140, track Gi0/1 down
   (-10)`), in the shape the owner note already uses (`engine/cli.js:4027-4031`).
4. **The track line survives a save, and can be unset** (S). Print `  vrrp 10 track Gi0/1 10` in the
   interface block (`engine/cli.js:7257-7266`), accept it back, and add `no vrrp <vrid> track
   <interface>` to the `no` dispatcher (`:2255-2299`). `toDoc()`/`fromDoc()` need no change: they deep-copy.
5. **`vrrp <vrid> preempt delay minimum <seconds>`** (M, new command word). Store `preemptDelaySec`;
   in `groupState()` gate the preempt branch (`engine/vrrp.js:460-466`) on the delay, and quote it in
   `vrrpTimers()` so the convergence schedule and the takeover agree on the same number.
6. **Docs** (S). `docs/SIMULATION.md` §5.4 gains a tracking row; the `vrrp` command block in `docs/CLI.md:3478-3497`
   gains `track` and `preempt delay`; a CHANGELOG line in the existing Unreleased section, not a new
   one (#1980).

**Deliberately left out:** advertisement-loss detection (a master displaced by going quiet). It needs
a held timestamp per group, which is the one thing `engine/vrrp.js:1-7` says the module does not keep;
the honest version is a `convergence.js` timer that re-elects with the loser marked down, and that is
a design decision for Jay rather than a worker. Also out: VRRPv3 and IPv6 virtual addresses, using the
stored authentication text, and HSRP/GLBP — all named absent at `SIMULATION.md:383-384`, all larger
than this plan.

## Risks

* Steps 1-2 can move a virtual gateway in a lab that already exists: a cable left down at run start
  now costs the master its VIP. That is the intended fix and belongs in the CHANGELOG line.
* The `Pri` column must keep quoting the priority the group voted with (the #1727 rule), while
  `show running-config` prints the configured value — a decrement must not leak into the saved config.
* Step 1 makes `computeVrrp()` run on every cable change, and it emits `vrrp`/`garp` events through
  `_emit()` (`engine/simulator.js:1108-1116`). Decide whether a re-election after a cable pull is a
  log entry or noise before wiring it, or the event log grows one entry per click.
* Tracking is per (vrid, interface) and one port may be tracked by several groups; a group tracking
  its own interface must be refused at parse time, not silently double-counted at election time.

## Test strategy

New: `test/vrrp-track.test.js` (parse, validate, decrement applied, floor 1, owner unaffected,
`no` form, running-config round-trip) and `test/vrrp-link-change.test.js` (claim moves on a cable pull
and on shutdown, exactly one `garp` per VIP, no stale `Master` row). Existing suites that must stay
green: `test/vrrp-in-path.test.js`, `test/vrrp.test.js`, `test/vrrp-priority-ceiling.test.js`,
`test/vrrp-vip-subnet.test.js`, `test/vrrp-no-form.test.js`, `test/show-vrrp-election.test.js`,
`test/show-vrrp-owner-priority.test.js`, `test/show-arp-vrrp-virtual-address.test.js`, plus
`test/docs-cli-transcript.test.js`, `test/docs-show-commands.test.js` and `test/help-completeness.test.js`
for step 6 and the new `?` word in step 2. `node test/engine.test.js` before every push.

## Issues this would close

None. The queue is #130 (device) and #1980 (changelog plan, already an open PR); steps here neither
touch the device catalogue nor restructure the changelog, so the plan is filed as forward work and
should be cited from the PRs it produces rather than closing a request.
