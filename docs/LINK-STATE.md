# Link state: pulling a cable

A link can be **down without being deleted**. The ports stay patched, the hardware stays as it was
catalogued, and nothing gets through — which is the difference between a lab where a technician
pulled a cable and a lab where a cable was never installed.

```bash
# from any device's CLI, because a cable is not owned by a box
R1#links
Link  Endpoints                State
l5    SW1:Fa0/1 <-> SW2:Fa0/1  up
l6    SW1:Fa0/2 <-> PC1:eth0   up

R1#link down l5 at 10000
Link l5 (SW1:Fa0/1 <-> SW2:Fa0/1) is now down.
Network converges again at 40000 ms.

R1#link state l5
Link l5  SW1:Fa0/1 <-> SW2:Fa0/1
  state: down since 10000 ms
  carries: nothing - the cable is down

R1#link up l5
```

A cable's state is what was done to the cable, so a cable into a port someone shut is still `up` and
carries nothing. Both facts are printed rather than the first passed off as the second:

```
R1#links
Link  Endpoints                State
l5    SW1:Fa0/1 <-> SW2:Fa0/1  up
l6    SW1:Fa0/2 <-> PC1:eth0   up
  l5: carries nothing - SW2/Fa0/1 is administratively down
  State is what was done to the cable; the lines above it are where no frame crosses.

R1#link state l5
Link l5  SW1:Fa0/1 <-> SW2:Fa0/1
  state: up
  carries: nothing - SW2/Fa0/1 is administratively down
```

Over HTTP, for the UI:

```
POST /api/topologies/:topoId/links/:linkId/state
{ "state": "down", "atMs": 10000 }
```

The response carries `reconvergeAtMs` and the whole convergence schedule. In the editor, right-click
a cable for **Take link down** / **Bring link up**; a down cable is drawn dashed and red
(`.link.link-down` in `web/style.css`).

One detail if you are writing a client against it: the handler builds its reply object with `state`
**twice** — the requested string, then the full topology state — and the last key wins. So the
reply's `state` is the topology, not `"down"`. Read `linkId`, `atMs`, `changed` and `reconvergeAtMs`
for what the change did, and `state.links[…]` for the result.

## What a state change actually does

Four things, and all four are what real gear does — the model would be a lie with any one missing.

| Effect | Why |
|---|---|
| **Frames die at the cable** | A frame crossing a down link is dropped with `reason: 'link down'` and the link id, so the timeline says where it died. Before this was enforced, `Link.state` was decorative: a cable marked down still carried every frame. |
| **The spanning tree is rebuilt** | A down cable is not a bridge port, so a redundant topology finds the other way. This is the whole reason STP exists, and it cannot be demonstrated if the tree ignores link state. |
| **Forwarding tables are flushed** | Every bridge's MAC table is emptied, not just the one whose port went down. Measured on a three-switch chain with a host at each end (3, 4 and 3 learned entries): cutting the **far** cable, two hops from the first switch, left `0, 0, 0`. Keeping the entries is how a real network black-holes after a failure: traffic is unicast into the port that used to lead somewhere. |
| **The convergence schedule re-bases** | Every control-plane timer runs again *from the instant of the change*. Without this, a lab that broke a cable reported the network as converged because it had converged once, hours earlier. |

The change instant is stored on the topology (`lastChangeAtMs`) and on the link
(`stateSinceMs`), not on a query object, so it survives save/load and every later question knows
when it happened.

**The flush stops at the bridges — a host's ARP cache is untouched.** After cutting a cable to a
PC, the switch's table is empty and the other PC's `show arp` still lists the neighbour it learned
before the cut (`Internet  10.0.0.11  -  02:00:00:00:02:00  -`). That is deliberate rather than
forgotten: nothing ages an ARP entry in this model, and `POST …/reset` (or the UI's *Reset state*)
is the operation that clears MAC tables **and** ARP caches together — measured end to end through
the API: after a successful ping, `show arp` holds `10.9.0.20` and `show mac address-table` holds two
`DYNAMIC` rows; after the reset both commands print their **header only**, with no rows and no
refusal line. A stale entry therefore survives a cable change but not a reset — worth knowing
before concluding the flush is broken.

**Two things are called reset and they do different jobs.** `Simulator.reset()` rewinds a *run* —
events, queue, step counter, DHCP lease state, the cached STP result — and deliberately leaves
`dev.macTable` and `dev.arp` alone, because `ping()` calls it first and a ping must not erase the
tables it is about to use. The forwarding state is cleared by the **server's** `/reset` handler,
which loops over devices calling `d.macTable.clear()` and `d.arp.clear()` and then resets flow state.
So scripting the engine directly and expecting tables to clear will not work; the endpoint is the
one that means "forget what the network learned".

## The window where nothing works

```
change at 10 s  →  converges at 40 s   (2 × forward delay, 15 s each)
```

Ask a question inside that window and the answer is honest about it. Two switches, a redundant
link, one of the pair cut at 10 s, then a ping asked at 11 s:

```
PC1#ping 10.0.0.11 at 11000
Type escape sequence to abort.
Sending 4, 100-byte ICMP Echos to 10.0.0.11, timeout is 2 seconds:  (at t=11000 ms)
....
Success rate is 0 percent (0/4)
% Still converging at t=11000 ms: stp on SW1, stp on SW2 (ready at 40000 ms)
% Still converging at t=11000 ms: stp on SW1, stp on SW2 (ready at 40000 ms)
% Still converging at t=11000 ms: stp on SW1, stp on SW2 (ready at 40000 ms)
% Still converging at t=11000 ms: stp on SW1, stp on SW2 (ready at 40000 ms)
```

One line per lost echo, each naming the processes that are not done and when they will be. The same
question asked at 41 s is `!!!!` and `Success rate is 100 percent (4/4)`, because the tree has
finished and the redundant link is forwarding.

A *flow* asked in the same window refuses with a different code than the ping hints at:

```
PC1#flow open 10.0.0.11 port 80 at 11000
% flow refused (E_STP): port in STP blocking state
% yet: stp on SW1 still converging (ready at 40000 ms), stp on SW2 still converging (ready at 40000 ms)
% try again after that, or ask at an instant with "at <ms>" (and "at converged" to go back)
```

`E_STP` is the honest code — the tree really is blocking — but a reader who saw `E_CONVERGING`
elsewhere and expects it here will not find it. Both messages name the same switches and the same
ready time, so the diagnosis is identical whichever one you get.

`converge` shows the same thing as data:

```
SW1#converge 20000
Process  Device    Ready     Basis
change   (change)  10000 ms  the link state changed
stp      SW1       40000 ms  listening + learning (15 s forward-delay each) (after the change at 10000 ms)  (pending)
stp      SW2       40000 ms  listening + learning (15 s forward-delay each) (after the change at 10000 ms)  (pending)

Fully converged at 40000 ms. (re-based at the link change at 10000 ms)
```

Note what `Basis` says and what `(pending)` marks: the reason is *listening and learning*, named per
switch, and the marker distinguishes a process that is merely waiting from one that never ran. A ping
asked inside the window reports the same information per lost echo — `% Still converging at t=11000
ms: stp on SW1, stp on SW2 (ready at 40000 ms)` — rather than "host unreachable", which would be a
different and wrong diagnosis.

### One rough edge: the figure `link down` quotes is always the STP one

`link down` answers with `reconvergeAtMs`, and the simulator computes that as **the change instant
plus two forward delays regardless of whether the topology contains a bridge**. In a lab with
switches that is right and `converge` agrees. In a **router-only** lab it is not: the CLI promises
40 s, then `converge` reports the network was already converged at the change instant, and nothing
was ever listening or learning.

Measured, lab2 (router + two PCs, no switches):

```
Router#link down l4 at 10000
Link l4 (PC-d1:eth0 <-> Router-d3:Gi0/0) is now down.
Network converges again at 40000 ms.          ← quoted unconditionally

Router#converge 20000
Process  Device    Ready     Basis
change   (change)  10000 ms  the link state changed

Fully converged at 10000 ms. (re-based at the link change at 10000 ms)
```

Nothing is wrong with the *model* — with no bridge there is no spanning tree, so the second answer is
the correct one and the ping at 11 s still fails because the cable is down. It is the one-line
summary that over-promises, and that is a bug in the seam, not a fidelity gap. Trust `converge`.

## Persistence

A lab saved with a cable down comes back with it down:

```json
{ "id": "l5", "a": {...}, "b": {...}, "state": "down", "stateSinceMs": 10000 }
```

and the topology records `"lastChangeAtMs": 10000`. Links that never changed carry no `stateSinceMs`
at all — a field on every cable would be noise in every diff and every regenerated example, and the
examples-idempotent test would fail on it, which is how that was caught.

## What "up" means: the cable, the ports, or both

`link.state` records what the operator did to the cable — `link down <id>` — and it persists. It is
not the same question as "is this link passing frames", and three readers used to print it as if it
were: the web inspector showed `State up` on every cable ever drawn, including one entering a port
the administrator had disabled, and `show interfaces transceiver` answered `(up)` for the same reason.
The ports' own state was already derived elsewhere — `Simulator.computePortState()` keeps `lineUp`
and `lineStateReason` — and nothing joined the two facts.

`Topology.linkState(link)` joins them: the cable's state plus both ports' `enabled` plus both ports'
`lineUp`, returning `{ up, cause, reason }` where `reason` names the port at fault
(`SW1/Fa0/1 is administratively down`, `PC1/eth0 is down (the cable is down)`, `SW1/Fa0/99 is gone`)
and `cause` says which kind of thing it was. `fullState()` attaches `carries` and `stateReason` to
every link in the payload; `serialize()` does not, because `lineUp` is a fact about the current
simulation and a saved copy would be read back as one.

Two answers that look contradictory and are both right:

| question | answered by | a port whose far peer is shut |
| --- | --- | --- |
| is *this interface* up? | `show ip interface brief`, `_ifaceState()` | **up** — nothing is wrong with this socket |
| does *this link* carry? | `Topology.linkState()` | **down** — the far end is shut |

The fault does not go unnamed: `_portNotCarryingReason()` reads the link's own answer and says
`the far port Fa0/1 on SW1 is administratively down`, which is what `show lldp neighbors` and
`show interfaces transceiver` print. The inspector renders four states rather than one: `up`,
`down - <reason>`, a separate `Cable` row when the cable itself was taken down (so "down" cannot be
misread as the cable's doing), and `not checked in this session` for a payload that predates the
field — never `up` by default, which is what the row used to claim.

The board follows the same rule. A cable whose port is disabled is drawn dashed and recoloured like a
cut one, because what `link-down` means on the canvas is "no frames cross here", not "somebody pulled
this out" — while the DOM keeps the two facts apart: `data-link-state` still reports the cable's own
state, `data-carries` reports the engine's answer, and `data-state-reason` carries the sentence naming
the end at fault. A payload from before the field existed is drawn as it was and labelled `unknown`:
nothing crosses is a claim, and nothing is known is not one.

## What this does not model

- **No physical-layer diagnosis.** A cable is up or down; it is never *degraded*. There is no CRC
  error rate, no intermittent fault, no flapping (a link cannot go down and up on its own over time).
- **No autonegotiation on recovery.** A link that comes back is at the speed it had; there is no
  renegotiation, no duplex mismatch, no error-disabled port waiting for `shutdown`/`no shutdown`.
- **No interface-level failure distinct from the cable.** `shutdown` on an interface and pulling the
  cable are modelled differently and both work, but a port that fails its own self-test does not
  exist.
- **STP only.** RSTP's fast convergence (sub-second proposal/agreement) is not modelled;
  re-convergence costs the same 30 s as first convergence. This is the largest single inaccuracy in
  this area, and it is deliberate: the timer model is 802.1D.
- **One change at a time.** Two links down at the same instant share one change timestamp, which is
  usually what a lab means, but a sequence of failures at different times collapses to the last one.

## Tests

- `test/link-state.test.js` — 84 assertions: a down link carries nothing and says where the frame
  died, `setLinkState` refusals, the tree healing around a failure, a network with no second path
  staying broken, the re-based schedule (nothing works at 11 s, works at 41 s), MAC table flush, the
  DHCP segment walk refusing to cross a cut cable, save/load, the CLI surface, `links` / `link state`
  reporting that a planted cable with a shut port carries nothing, and this page's own transcript
  checked line for line against a fresh run.
- `test/link-state-drawing.test.js` — 22 assertions: the renderer marks a down cable, marks a cable
  whose port is disabled without claiming the cable is down, keeps its medium class in both cases,
  labels a payload that predates the field `unknown` rather than guessing, and the stylesheet really
  dashes and recolours it.
- `test/link-carries.test.js` — 43 assertions: `linkState()`'s four causes (shut port, far port shut,
  cable down, socket gone), the console/engine matrix including the case where a port is genuinely up
  while its link is not, that a cable called non-carrying really passes no frame (a ping across a shut
  port fails, from either end), the payload contract (derived on read, absent from the saved file), and
  the inspector's four renderings — including that the row never says `up` when the payload does not.
