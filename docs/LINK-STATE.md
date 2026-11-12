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

The response carries `reconvergeAtMs` (`atMs` plus the STP forwarding budget, so `10000` arrives as
`40000`) and the whole convergence schedule under the key **`convergence`** — an object
`{ entries, convergedAtMs, byProcess, fromMs }`, with every entry anchored at `fromMs`, the instant of the
change. In the editor, right-click
a cable for **Take link down** / **Bring link up**; a down cable is drawn dashed and red
(`.link.link-down` in `web/style.css`).

One detail if you are writing a client against it: the handler builds its reply object with `state`
**twice** — the requested string, then the full topology state — and the last key wins. So the
reply's `state` is the topology, not `"down"`. Read `linkId`, `atMs`, `changed` and `reconvergeAtMs`
for what the change did, and `state.links[…]` for the result.

Two more things about that payload are only visible if you have measured it. **`convergence.entries` is not
a lightweight index**: each entry carries the entire serialised device — spec, interfaces and all — so on
`examples/lab4-vlans-trunk-stp.json` the schedule is 3,837 bytes for 3 entries that need 160 (`d1`, `d2`
and the `change` pseudo-entry); on `lab3-multi-vendor-campus.json`, 8,699 bytes for 4 entries needing 212.
That is roughly 24× and 41× the information, and it grows with the size of the box rather than with the
number of events.

Re-measured over HTTP on 2026-11-12, loading each lab with `…/load` and taking its first link down with
`{"state":"down","atMs":10000}`: **3,747** bytes for lab4's 3 entries and **8,609** for lab3's 4 — both exactly
**90 bytes lighter** than the reading above, which is the shape of the thing being described. The count is a
measurement of the *serialised devices*, not of the schedule: it moves when a spec gains a field, and it does not
move when a lab gains an event. Per entry it is **1,249** bytes on lab4 against **2,152** on lab3, so the cost
tracks how big the boxes are rather than how much happened to them. Same run confirmed the other two claims:
`reconvergeAtMs` came back `40000` for `atMs: 10000` on both labs, and the reply's `state` is the topology rather
than the string `"down"`. And **`affects` does not survive the trip**: `sim.setLinkState()` returns
`affects: [deviceA, deviceB]`, but the HTTP handler builds its reply field by field and never copies it,
so a client has to find the two ends in `state.links[linkId]` instead.

**Two traps in reproducing that.** `/load` answers `404 topology not found` until the id exists, because
`server/index.js:349` bails on a missing topology before the `/load` branch at `:673` — so the sequence is
`POST /api/topologies {"id":"b1"}`, then `POST /api/topologies/b1/load`, then
`POST /api/topologies/b1/links/<id>/state {"state":"down","atMs":10000}`. And the link id is not an index:
`state.links` is an **array**, so `Object.keys()` gives `"0"`, `"1"`, … and those 404 as well; the first
elements on the two labs are `l6` and `l9`. Each entry is `{deviceId, device, process, readyAtMs, basis}`,
where `device` is the whole serialised spec — which is why the byte count tracks box size and not event
count.

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
% Still converging at t=11000 ms: stp on SW1, stp on SW2 (ready at 40000 ms)
% Still converging at t=11000 ms: stp on SW1, stp on SW2 (ready at 40000 ms)
% Still converging at t=11000 ms: stp on SW1, stp on SW2 (ready at 40000 ms)
% Still converging at t=11000 ms: stp on SW1, stp on SW2 (ready at 40000 ms)
Success rate is 0 percent (0/4)
```

Re-run on 2026-11-12 against a lab that ships with the repository — `examples/lab4-vlans-trunk-stp.json`, whose
`l6`/`l7` are the redundant pair — every line above reproduces character for character, **with that lab's own
address**. Its PCs are `192.168.10.10`, `.20` and `.30`, so the transcript re-runs as
`ping 192.168.10.20 at 11000`: `link down l6 at 10000` answers `Link l6 (SW1:Fa0/8 <-> SW2:Fa0/8) is now down.`
then `Network converges again at 40000 ms.`, the ping prints `....` and **four** identical
`% Still converging at t=11000 ms: … (ready at 40000 ms)` lines and `Success rate is 0 percent (0/4)`, the same
question at `at 41000` is `!!!!` with `Success rate is 100 percent (4/4)`, `converge 20000` prints the
`change (change) 10000 ms the link state changed` row above the two per-switch `stp` rows and ends
`Fully converged at 40000 ms. (re-based at the link change at 10000 ms)`, and `flow open … at 11000` refuses with
`% flow refused (E_STP): port in STP blocking state`. Nothing in this section is hand-written.

**Keep the address, or the reproduction lies to you.** The fence above asks for `10.0.0.11`, which no device in
that lab has; at `at 11000` the wrong target still prints the four converging lines and `0 percent (0/4)`, so the
run looks correct. The difference only shows on the other side of the window: `at 41000` then answers `....` with
`Request timed out (seq 0)` through `(seq 3)` and `0 percent (0/4)` instead of `!!!!`, and `flow open` refuses
`E_NO_ROUTE` instead of `E_STP` — the converging hint is answered before the route lookup, so while the tree is
down a destination that does not exist is indistinguishable from one that does.

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

`E_STP` is the honest code — the tree really is blocking. There is no `E_CONVERGING` code in this
engine at all: it has never appeared in `engine/` in any commit, and the ping's prose above is the only
place the idea is named, so a flow refused inside the window answers `E_STP` and nothing else. Both
messages name the same switches and the same ready time, so the diagnosis is identical whichever one
you get.

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

`link down` answers with `reconvergeAtMs`, and the simulator computes that as **the change instant plus two
forward delays taken from an empty config** — `convergenceLib.stpTimers({})` at `engine/simulator.js:694`, so
the figure is always `atMs + 30 000` and nothing on the board is consulted. In a lab with switches at the
default 15 s that is right and `converge` agrees. In a **router-only** lab it is not: the CLI promises 40 s,
then `converge` reports the network was already converged at the change instant, and nothing was ever
listening or learning.

The same seam opens whenever a switch declares its own forward delay, because the figure does not read it.
Give both `lab4` switches `stpForwardDelaySec: 4` and `link down l6 at 10000` still answers
`Network converges again at 40000 ms.`, while `converge 20000` prints `stp      SW1       18000 ms  listening +
learning (4 s forward-delay each)`, the same for `SW2`, and `Fully converged at 18000 ms.` — a 22 s
disagreement in a lab that has bridges, not one that lacks them.

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

Both blocks come from `examples/lab2-router-two-subnets.json`, link **`l4`** between `PC-d1` and
`Router-d3`, so they can be reproduced line for line: `link down l4 at 10000` answers `Link l4
(PC-d1:eth0 <-> Router-d3:Gi0/0) is now down.` / `Network converges again at 40000 ms.`, and `converge 20000`
then prints only the `change` row and `Fully converged at 10000 ms. (re-based at the link change at 10000 ms)`,
re-read on 2026-11-12.

Nothing is wrong with the *model* — with no bridge there is no spanning tree, so the second answer is
the correct one and the ping at 11 s still fails because the cable is down. It is the one-line
summary that over-promises, and that is a bug in the seam, not a fidelity gap. Trust `converge`.

## Persistence

A lab saved with a cable down comes back with it down:

```json
{ "id": "l5", "a": {...}, "b": {...}, "state": "down", "stateSinceMs": 10000 }
```

and the topology records `"lastChangeAtMs": 10000`. Read back from the live object rather than the JSON
(2026-11-12, `lab2`: `topology.links` is a **Map** keyed by link id) the changed link is `state: 'down'`,
`stateSinceMs: 10000` and `topology.lastChangeAtMs` is `10000` — the two numbers the file shows are the two
the model holds. Links that never changed carry no `stateSinceMs`
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
and `cause` says which kind of thing it was — `cable`, `admin`, `line` or `gone`, and `null` when the answer is yes.

**Where that answer reaches a payload is a function in the server, not a method on `Topology`.** This
page used to say "`fullState()` attaches `carries` and `stateReason`", which reads as
`topology.fullState()` and is not: there is no such method, and half an hour goes into looking for it.
`fullState(topo)` lives in `server/index.js`, is called by every HTTP handler that returns a topology
and by the WebSocket broadcast, and it adds three keys per link on top of `serialize()`:

| key | from | what it answers |
| --- | --- | --- |
| `verdict` | `Topology.linkVerdict(link)` — the same rule that let the cable be built | would this cable validate now, and what would it warn about |
| `carries` | `Topology.linkState(link).up` | do frames actually cross |
| `stateReason` | `Topology.linkState(link).reason` | if not, which end and why |

`serialize()` carries none of the three, because `lineUp` is a fact about the current simulation and a
saved copy would be read back as one. Measured, a saved link is exactly
`id, a, b, type, mediaId, speedMbps, duplex, lengthM, lagId, patchCord, state` — `state` is the file's
own record of "somebody took this cable down", which is why the *derived* answer needed a different
name. The payload's top level is `format, version, seq, devices, links, layout` before `fullState`
touches it.

The links are not the whole of what `fullState()` adds: it also sets `s.runtime`, one entry per device
holding `macTable`, `arp`, `routes` (`routesTable()`) and `counters` — and a device with no counters yet
gets zeros rather than a missing key, so a table or a sparkline never has to test for absence. All of it
is recomputed on **every** payload rather than cached; the comment beside the loop puts the cost at
about 5 µs per cable (a 211-cable board serialises in 1.24 ms against 0.21 ms without), which is the
price of not being able to show a verdict about hardware that has since changed.

`fullState()` is not an engine method — it lives in `server/index.js`, where the payload is actually
served, so `sim.fullState()` throws `TypeError: sim.fullState is not a function` and the engine's own
answer stops at `Topology.serialize()`. Ask the server (any route that returns a state envelope) or
call the function in that file; there is nothing to import from `engine`.

Measured again on a differently shaped board — 212 cables, each between its own switch and PC, so 424
devices rather than a handful of switches — the same constant shows up and the absolutes do not:

| board | `serialize()` alone | with verdicts on every link | delta per cable |
|---|---|---|---|
| 211 cables on a few switches (the comment's board) | 0.21 ms | 1.24 ms | ~5 µs |
| 212 cables, one switch + one PC each (424 devices) | 0.69 ms | 1.78 ms | **5.12 µs** |

The per-cable constant is the part that holds across boards; the totals track device count, because
every device also gets a `runtime` entry. Two readings that disagree about milliseconds can still agree
about the price of a cable.

Two answers that look contradictory and are both right:

| question | answered by | a port whose far peer is shut |
| --- | --- | --- |
| is *this interface* up? | `show ip interface brief`, `_ifaceState()` | **up** — nothing is wrong with this socket |
| does *this link* carry? | `Topology.linkState()` | **down** — the far end is shut |

The fault does not go unnamed: `_portNotCarryingReason()` reads the link's own answer and says
`the far port Fa0/1 on SW1 is administratively down`, which is what `show lldp neighbors` and
`show interfaces transceiver` print.

Both of those need a row to hang the note on, and that is what the sentence above leaves out. The
transceiver note rides the caged port's own row; the LLDP note rides a neighbour that was actually
heard, so a port with no entry answers `(none - no LLDP has been heard on any port)` and quotes
nothing at all. Make the entry first — two SFP routers, an address each, one ping — then shut the far
end and ask both questions:

```bash
node -e "const{Topology,Simulator,runCommands}=require('./engine'),{loadCatalog}=require('./devices/registry');
  const cat=loadCatalog('./devices'),sp=m=>cat.find(x=>String(x.model)===m);
  const t=new Topology(),a=t.addDevice(sp('ASR 1001-X')),b=t.addDevice(sp('ASR 1001-X'));
  a.name='A1';b.name='B1';const l=t.connect(a.id,'Gi0/0/0',b.id,'Gi0/0/0');const sim=new Simulator(t);
  const cli=(d,c)=>runCommands(d,t,sim,c).lines;
  for(const d of [a,b])cli(d,['enable','configure terminal','lldp run','exit']);
  cli(a,['enable','configure terminal','interface Gi0/0/0','ip address 10.9.0.1 255.255.255.0','exit']);
  cli(b,['enable','configure terminal','interface Gi0/0/0','ip address 10.9.0.2 255.255.255.0','exit']);
  cli(a,['ping 10.9.0.2']);cli(a,['show lldp neighbors']);
  b.interfaces.get('Gi0/0/0').enabled=false;sim.computePortState();
  for(const c of ['show interfaces transceiver','show lldp neighbors'])
    for(const line of cli(a,[c]))if(/far port/.test(line))console.log(c+': '+line.trim());"
```

It prints `show interfaces transceiver: Gi0/0/0: the far port Gi0/0/0 on B1 is administratively down`
and `show lldp neighbors: Gi0/0/0: B1 was heard here, but the far port Gi0/0/0 on B1 is administratively
down` — the same sentence twice, the second carrying the observation that makes it worth printing.
Neither answer names the end at fault on its own; that name comes from the link's reader, which is the
value of asking the link rather than the socket.

The inspector renders four states rather than one: `up`,
`down - <reason>`, a separate `Cable` row when the cable itself was taken down (so "down" cannot be
misread as the cable's doing), and `not checked in this session` for a payload that predates the
field — never `up` by default, which is what the row used to claim.

The board follows the same rule. A cable whose port is disabled is drawn dashed and recoloured like a
cut one, because what `link-down` means on the canvas is "no frames cross here", not "somebody pulled
this out" — while the DOM keeps the two facts apart: `data-link-state` still reports the cable's own
state, `data-carries` reports the engine's answer, and `data-state-reason` carries the sentence naming
the end at fault. A payload from before the field existed is drawn as it was and labelled `unknown`:
nothing crosses is a claim, and nothing is known is not one.

## Path cost, and how the blocked port is chosen

`show spanning-tree` prints a `Cost` column per port, so the number that decides which port blocks is
visible rather than implied. It is derived from the port's speed, with `spanning-tree cost <n>` as the
per-port override — the same precedence as real gear:

| Port speed | Cost | Where it comes from |
|---|---|---|
| 100G exactly | 200 | `SPEED_COST[100000]` |
| 40G | 500 | `SPEED_COST[40000]` — the standard long-method value |
| 10G | 2000 | `SPEED_COST[10000]` |
| 1G | 20000 | `SPEED_COST[1000]` |
| 100M | 200000 | `SPEED_COST[100]` |
| 10M | 2000000 | `SPEED_COST[10]` |
| **anything else** | 20000 | the fallback, `DEFAULT_PORT_COST` |

That last row is the one worth reading twice. `SPEED_COST` holds **six** keys and every other rate falls
back to the 1G cost — measured through `runStp()` on a port at each rate: 2.5G → `20000`, 25G → `20000`,
50G → `20000`, 400G → `20000`, unknown → `20000`, and 100G → `200`. So a topology built to make 25G and
50G compete is really a race between two 1G links, and a 400G link is *more expensive* than the 10G link
beside it — 20000 against 2000 — because it is priced as 1G. This page used to print a smooth ladder (40G 400, 25G 800, "100G and faster" 200),
none of which the engine computes.

The fallback is measurable without a lab, since `runStp()` prices a port from `speedMbps` when the port
states one. Give two bridges a link at each rate and read the surviving port's `cost`:

```sh
node -e 'const {runStp}=require("./engine/stp");const t=s=>{const p={name:"Fa0/1",speedMbps:s,to:{bridge:"b2",port:"Fa0/1"}};const r=runStp({bridges:[{key:"b1",priority:32768,mac:"02:00:00:00:01:00",ports:[p]},{key:"b2",priority:32768,mac:"02:00:00:00:02:00",ports:[{name:"Fa0/1",speedMbps:s,to:{bridge:"b1",port:"Fa0/1"}}]}]});return r.ports.b1["Fa0/1"].cost};for(const s of [1000,10000,40000,100000,2500,25000,50000,400000])console.log(s,"->",t(s))'
```

Run at `920cccc5` it prints `1000 -> 20000`, `10000 -> 2000`, `40000 -> 500`, `100000 -> 200`, then
`2500 -> 20000`, `25000 -> 20000`, `50000 -> 20000`, `400000 -> 20000` — the six-key table and the fallback,
in the order that makes the gap obvious: every rate between the keys is priced as 1G. A port carrying
`cost: 0` or `cost: 500` reports that number verbatim, which is the override the next section depends on.
The list tests eight of the table's ten rows; put `10` and `100` in front of it and the same call answers
`10 -> 2000000` and `100 -> 200000`, so all six keys are covered by one probe and every rate *between*
them still comes out at 20000.

**The override is whatever you typed, including `0`.** `portCost()` (`engine/stp.js:71`) reads
`port.cost` first and accepts any finite value `>= 0`, so the speed table never runs on a port that
declares a cost — and `0` is a legal cost rather than "unset". Measured through `runStp()` on a bridge
with a 100G uplink (cost `200`) and a 1G uplink (cost `20000`):

| `cost` on the two ports | `show spanning-tree`-visible result |
|---|---|
| neither set | 100G port `forwarding` (200), 1G port `blocking` (20000) — the expected election |
| 1G port `cost: 0` | the **1G** port becomes the root port and forwards (0), the 100G link blocks (200) |
| 1G port `cost: 500` | 100G still forwards (200) and the 1G port blocks, but its printed cost is `500`, not 20000 |

So a typo that lands `0` in a cost field does not fall back to the speed-derived number, it silently makes
that link the preferred path — and nothing warns, because the value is legal. The printed `Cost` column is
the way to see it: it echoes the override verbatim.

All three rows were re-measured on 2026-11-12 through `runStp()` and hold exactly — reading the **non-root** bridge,
`Gi0/1` (100G) is `forwarding/200/root` and `Gi0/2` (1G) `blocking/20000/alternate` with no override; with
`cost: 0` on the 1G port it flips to `blocking/200/alternate` and `forwarding/0/root`; with `cost: 500` the roles
are back but the printed cost is `500`. One trap, because it cost two attempts here: **the override has to be on the
bridge you read.** Cost is a local per-port property, so a probe that writes `cost: 0` onto the *peer's* port and
then reads the bridge under test gets `20000` and concludes the override was ignored — which is exactly what
happened before the topology was moved around.

The values it *does* compute are IEEE's long-method costs, so a lab whose rates are in the table agrees
with a vendor datasheet. Nothing depends on that being standard — the *relative* order is what picks the
topology — but the order only exists between two rates that are both in the table.

Cost is what makes a topology change visible. Three switches in a triangle, `SW1 -- SW2` direct and
`SW1 -- SW3 -- SW2` as the detour, all 1G:

```
SW2#show spanning-tree
  This bridge: SW2 priority 32768, 02:00:00:00:01:00   root path cost 20000
Port   Role        State       Cost
Fa0/1  root        forwarding  20000          (the direct link)
Fa0/2  designated  forwarding  20000

SW2(config)#interface Fa0/1
SW2(config-if)#spanning-tree cost 200000      (on both ends of the direct link)

SW2#show spanning-tree
Port   Role       State                         Cost
Fa0/1  alternate  blocking   (traffic dropped)  200000
Fa0/2  root       forwarding                    20000
  Fa0/1 is alternate: SW1 reaches the root for 0, this bridge for 40000
```

Two details worth keeping. The override applies to **the port it is typed on**, and a bridge measures its
own path from its own port cost — so raising it on `SW1`'s side alone changes nothing at `SW2`, which
still reads `root path cost 20000` and keeps forwarding:

```
SW1(config-if)#spanning-tree cost 200000      (SW1's end only)
SW2#show spanning-tree
  This bridge: SW2 priority 32768, 02:00:00:00:01:00   root path cost 20000
Fa0/1  root        forwarding  20000
```

Second, the port that loses prints the arithmetic that decided against it —
`Fa0/1 is alternate: SW1 reaches the root for 0, this bridge for 40000` — rather than just going quiet.

The transcripts above print `SW2#` for a reason a probe has to reproduce deliberately. `prompt()`
reads `config.hostname || device.hostname || device.name` (`engine/cli.js:368`), and `device.hostname`
is never empty — a freshly built `generic-switch` already carries `Switch (L2)-d1` — so the third
fallback never fires: naming a device in code (`dev.name = 'SW2'`) changes nothing on screen, and
`hostname SW2` in config mode is what renames the prompt. Mode is per session as well, so `enable` and
the `show` have to arrive in the same batch or the prompt comes back as `SW2>`. Between the two, the
same tree prints either `SW2#show spanning-tree` or `Switch (L2)-d2>show spanning-tree`.


## What this does not model

- **No physical-layer diagnosis.** A cable is up or down; it is never *degraded*. There is no CRC
  error rate, no intermittent fault, no flapping (a link cannot go down and up on its own over time).
- **No autonegotiation on recovery.** A link that comes back is at the speed it had; nothing is
  renegotiated, so a marginal link returns exactly as marginal as it left. Two things the wording
  here used to call missing are not: a duplex mismatch is a *configuration* fault the validator
  raises as `W_DUPLEX_MISMATCH`, not something a link negotiates; and an err-disabled port does
  exist, just never from a link event. It comes from port security — `switchport port-security
  violation shutdown` err-disables the port (`Port Status : Secure-shutdown`), the summary counts it
  (`1 err-disabled by a violation: Fa0/1 - "shutdown" then "no shutdown" recovers`), and the way back
  is `no shutdown`, which runs `recover()` (`engine/portsecurity.js:150-159`, called from
  `engine/cli.js:2173`).
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
