# Link state: pulling a cable

A link can be **down without being deleted**. The ports stay patched, the hardware stays as it was
catalogued, and nothing gets through — which is the difference between a lab where a technician
pulled a cable and a lab where a cable was never installed.

```bash
# from any device's CLI, because a cable is not owned by a box
R1#links
Link   Endpoints                                                  State
l5     SW1:Fa0/1 <-> SW2:Fa0/1                                     up
l6     SW1:Fa0/2 <-> PC1:eth0                                      up

R1#link down l5 at 10000
Link l5 (SW1:Fa0/1 <-> SW2:Fa0/1) is now down.
Network converges again at 40000 ms.

R1#link state l5
Link l5  SW1:Fa0/1 <-> SW2:Fa0/1
  state: down since 10000 ms

R1#link up l5
```

Over HTTP, for the UI:

```
POST /api/topologies/:topoId/links/:linkId/state
{ "state": "down", "atMs": 10000 }
```

The response carries `reconvergeAtMs` and the whole convergence schedule. In the editor, right-click
a cable for **Take link down** / **Bring link up**; a down cable is drawn dashed and red.

## What the views say about it

A link taken down is a *patched cable that carries nothing*, which is a different fault from a socket
with nothing plugged into it. Both read as "down", and the reason tells them apart — in the CLI, on the
canvas, on the front panel and in the inspector:

| Situation | CLI (`show ip interface brief`) | Panel and canvas |
|---|---|---|
| the port is shut | `administratively down` | `administratively down` |
| nothing plugged in | `down` / `down` | `notconnect`, `down (no cable)` |
| `link down` on the cable | `down` / `down` | `down (link down)` |
| the far port is shut | `down` / `down` | `down (peer shut down)` |

The rule behind those four sentences lives in one place — `Device.ifaceStatus()` for the CLI and
`portState()` in `web/faceplate.js` for the UI, which the canvas and the inspector both call — and
`test/port-state-agreement.test.js` asserts the two agree, case for case, because a second
implementation of a rule is a second chance to disagree.

## What a state change actually does

Four things, and all four are what real gear does — the model would be a lie with any one missing.

| Effect | Why |
|---|---|
| **Frames die at the cable** | A frame crossing a down link is dropped with `reason: 'link down'` and the link id, so the timeline says where it died. Before this was enforced, `Link.state` was decorative: a cable marked down still carried every frame. |
| **The spanning tree is rebuilt** | A down cable is not a bridge port, so a redundant topology finds the other way. This is the whole reason STP exists, and it cannot be demonstrated if the tree ignores link state. |
| **Forwarding tables are flushed** | A topology change notification empties every bridge's MAC table. Keeping the entries is how a real network black-holes after a failure: traffic is unicast into the port that used to lead somewhere. |
| **The convergence schedule re-bases** | Every control-plane timer runs again *from the instant of the change*. Without this, a lab that broke a cable reported the network as converged because it had converged once, hours earlier. |

The change instant is stored on the topology (`lastChangeAtMs`) and on the link
(`stateSinceMs`), not on a query object, so it survives save/load and every later question knows
when it happened.

## The window where nothing works

```
change at 10 s  →  converges at 40 s   (2 × forward delay, 15 s each)
```

Ask a question inside that window and the answer is honest about it:

```
R1#ping 10.0.0.2
....    ← nothing gets through: the tree is still listening and learning
```

`converge` shows the same thing as data:

```
R1#converge 20000
Process   Device                 Ready   Basis
change    (change)               10000 ms the link state changed
stp       SW1                    40000 ms forwarding delay after a topology change (after the change at 10000 ms)
...
Fully converged at 40000 ms. (re-based at the link change at 10000 ms)
```

A ping asked before the window closes fails with `reason: 'converging'` and names the processes that
are not done — not "host unreachable", which would be a different and wrong diagnosis.

## Persistence

A lab saved with a cable down comes back with it down:

```json
{ "id": "l5", "a": {...}, "b": {...}, "state": "down", "stateSinceMs": 10000 }
```

and the topology records `"lastChangeAtMs": 10000`. Links that never changed carry no `stateSinceMs`
at all — a field on every cable would be noise in every diff and every regenerated example, and the
examples-idempotent test would fail on it, which is how that was caught.

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

- `test/link-state.test.js` — 67 assertions: a down link carries nothing and says where the frame
  died, `setLinkState` refusals, the tree healing around a failure, a network with no second path
  staying broken, the re-based schedule (nothing works at 11 s, works at 41 s), MAC table flush, the
  DHCP segment walk refusing to cross a cut cable, save/load, and the CLI surface.
- `test/link-state-drawing.test.js` — 13 assertions: the renderer marks a down cable, keeps its
  medium class, and the stylesheet really dashes and recolours it.

## What a state means for traffic

A port that cannot carry a frame is not a candidate for anything: it is not flooded to, it is not a BGP or
OSPF egress, its bundle membership is decided by `engine/lag.js`, and the tables that print learned state say
why it cannot be used rather than presenting the entry as current. `Device.ifaceStatus(iface, topo)` is the
one rule, and every caller shares it:

| caller | what it does with the answer |
|---|---|
| `show ip interface brief`, `show interfaces` | prints the status and the reason |
| `show arp`, `show mac address-table`, `show lldp` | marks the entry `(down: link down)` and keeps it |
| `show ip route` | marks a configured route whose egress cannot carry |
| `show etherchannel summary` | `(P)` only for members that can carry, `(D)` with the reason otherwise |
| canvas, faceplate, inspector | the same sentence in the tooltip and the status bar |
| inspector interface header | counts the ports that can carry, and names every other one by reason |
| `_forwardL2()` | a flood skips it — broadcasting into a dead port invents a discard that never happened |
| BGP, OSPF | a session or adjacency needs a wire that can carry it |

### The header is a summary of the rows under it

`Interfaces  28 ports · 0 up · 28 down (no cable)` is one sentence, but it is the one people read, and it used
to be computed from `enabled` — so a switch with nothing plugged in read `28 ports · 28 up` while the front panel
two lines above painted every socket `notconnect` and the console said `down (no cable)` for all 28. Worse, a
port whose peer had shut down and a port whose cable had been taken down counted as up, which are exactly the
two situations an operator opens the inspector to diagnose.

The header now counts through `portVerdict()`, the same rule the rows, the faceplate, the tooltip and the status
bar use, and every port that is not up is accounted for by the reason the console prints — never dropped from
the total:

```
28 ports · 1 up · 27 down (no cable)
28 ports · 0 up · 27 down (no cable) · 1 down (link down)
28 ports · 0 up · 27 down (no cable) · 1 administratively down
```

If the state rule itself is missing (a deployment where `web/faceplate.js` failed to load), the header says
`unknown (no state rule loaded)` rather than falling back to `enabled` — the guess that produced the bug. A
summary that guesses is worse than one that admits it cannot tell.
