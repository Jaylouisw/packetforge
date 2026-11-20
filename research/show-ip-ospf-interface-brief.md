# `show ip ospf interface brief`: what the table holds, and which cells this engine can fill

**Question (one, narrow).** The `brief` keyword of `show ip ospf interface` prints a seven-cell table.
What are those cells, in what order and at what widths - and which of them can this engine fill from
state it actually computes, as opposed to state a vendor box has and a simulator would have to invent?

**Verdict: the shape is known, four of the seven cells are derivable, three are not.** The console used
to read `brief` as a port name and answer `% No interface brief on <box>` - the sentence a misspelt port
gets, about a command every IOS box has. It now refuses the view by name, prints the header it would
have, and says which cell no other view stands in for (the PID). The table itself is not printed: `PID`
is the id from `router ospf <process-id>`, a command this console does not model (it has one unnamed
process and says `Routing Process with ID <router-id>`), and `State` is the port's DR/BDR role, which
the engine elects only across a cable with two speakers. A seven-column table with two invented cells
is worse than an honest refusal - the rule `research/show-ospf-interface-shut-port.md` already applied
to the block view, which stops where the model's knowledge stops.

## Evidence

| Source | Prints |
| --- | --- |
| [Cisco IOS IP Routing: OSPF Command Reference, "OSPF Commands: show ip ospf through T"](http://www.cisco.com/c/en/us/td/docs/ios-xml/ios/iproute_ospf/command/iro-cr-book/ospf-s1.html) | The grammar: `show ip [ospf] [process-id] interface [type number] [brief] [multicast] [topology ...]`. `brief` = "(Optional) Displays brief overview information for OSPF interfaces, states, addresses and masks, and areas on the device". The field table names `Process ID` (the OSPF process id), `Area`, `Cost`, `State` and `Nbrs F/C` ("OSPF neighbor count"). Its multitopology sample carries the header verbatim: `Interface PID Area IP Address/Mask Cost State Nbrs F/C` with rows `Lo0 1 0 10.0.0.2/32 1 LOOP 0/0` and `Se2/0 1 0 10.1.0.2/30 10 P2P 1/1`. |
| [Cisco Networking Academy, "Lab - Configuring Multiarea OSPFv2" (6.2.3.8), pages 4-6](https://cisco.tu-sofia.bg/wp-content/uploads/courses/CCNA3/course/files/6.2.3.8%20Lab%20-%20Configuring%20Multiarea%20OSPFv2.pdf) | IOS 15.2(4)M3 on 1941s, the one capture in hand whose **spacing survives extraction**, so it is the one the widths below are measured off. `R1# show ip ospf interface brief` then `Interface    PID   Area            IP Address/Mask    Cost  State Nbrs F/C` / `Se0/0/0      1     0               192.168.12.1/30    781   P2P   1/1` / `Lo1          1     1               192.168.1.1/24     1     LOOP  0/0`; R2 adds `Se0/0/1` at `1/1`; R3 is all `LOOP 0/0` and `P2P 1/1`. A passive loopback is listed (`LOOP`) and a passive interface is still a row. |
| [Cisco Press, "Implementing OSPFv2" (CCNP/CCNA chapter 22, §22-3)](https://www.ciscopress.com/articles/article.asp?p=3197438&seqNum=3) | `R1# show ip ospf interface brief` / `Interface PID Area IP Address/Mask Cost State Nbrs F/C` / `Gi0/0/0 1 0 10.1.1.1/24 1 DR 0/0` / `Gi0/0/1 1 0 10.1.12.1/24 1 BDR 1/1`, with the prose definition: "Each line identifies the OSPF process ID (per the **router ospf** *process-id* command), the area, the interface IP address, and the number of neighbors found via each interface." A broadcast port with **no** neighbour is `DR 0/0` - the state is the interface's role, not an adjacency count. |
| [kazulog.info, "IOS XE OSPF Basic Configuration"](https://kazulog.info/en/routerswitch/ios-xe/ospf/) (IOS XE) | Same header, and the two cells defined: "`Nbrs F/C` is the number of adjacencies (Full) and the number of detected neighbors", and the DR note: a **passive** `Gi2` "shows `0/0` for `Nbrs F/C`. However **`State` is still `DR`**, so this list alone does not tell you whether an interface is passive". |
| [Cisco Learning Network, "show ip ospf interface brief"](https://learningnetwork.cisco.com/s/question/0D53i00000Kt0HWCAZ/show-ip-ospf-interface-brief) | A third box, column order intact though spacing collapsed: `Fa0/1 3 0 192.168.3.3/26 10 DR 0/0` / `Se0/0 3 0 10.1.23.1/30 64 P2P 1/1` / `Fa0/0 3 0 10.1.3.3/26 10 DR 0/0`. PID is 3 here, i.e. the column really is the configured process id and not a constant 1. |
| [RUCKUS FastIron Command Reference 09.0.10 / 10.0.10, `show ip ospf interface`](https://docs.ruckusnetworks.com/prod/ruckus-docs/fastiron-09010-commandref/$/showipospfinterfaceGUID-6011DB34-9FD3-4409-8937-3F1D476E2F8A8en-US) | A non-Cisco box's field list for the same view, useful because it spells the vocabulary out: `State` is one of DR, BDR, Loopback, P2P, Passive, Waiting, None, Down, DR other, Active; the full view separates `Neighbor Count` from `Adjacent Neighbor Count` - the two halves of `F/C`. Its own header differs (`Number of Interfaces is 1`, `Interface Area IP Addr/Mask Cost State Nbrs(F/C)`), which is why the widths below are taken from the Cisco capture and not from a merged reading. |

## The columns, measured

From the Academy capture, every cell is padded to its header's width and the row's cell is padded to the
same width, so the header and the rows line up character for character:

| Cell | Width (columns 1-based) | Filled from |
| --- | --- | --- |
| `Interface` | 13 | the port name, **abbreviated** (`Se0/0/0`, `Gi0/0/1`, `Lo1`) - the same spelling `show ip ospf interface` uses in this console |
| `PID` | 6 | the OSPF process id (`router ospf <process-id>`) |
| `Area` | 16 | the port's area - decimal or dotted, as configured |
| `IP Address/Mask` | 19 | `<address>/<prefix-length>` |
| `Cost` | 6 | the port's OSPF cost |
| `State` | 6 | the interface's DR/BDR role on broadcast media, or `P2P` / `LOOP` / `DOWN` |
| `Nbrs F/C` | to end of line | neighbours in **Full** state / neighbours **detected** |

Header line, character for character: `Interface    PID   Area            IP Address/Mask    Cost  State Nbrs F/C`
(class: `Interface` + 4, `PID` + 3, `Area` + 12, `IP Address/Mask` + 4, `Cost` + 2, `State` + 1).
A row: `Se0/0/0      1     0               192.168.12.1/30    781   P2P   1/1`.

## What this engine has, cell by cell

* **Interface, Area, IP Address/Mask, Cost - all four exist.** `dev.ospfInterfaces` carries `name`,
  `area`, `ip`, `mask`, `cost` and `costSource`, and `show ip ospf interface` already prints them in a
  table of this console's own. The name comes from `iface-name.displayName()`; the abbreviated spelling
  is what the existing table prints.
* **PID - does not exist, and cannot be faked.** `computeOspf()` has one process, configured by
  `ospf router-id <ip>`, and the summary view says `Routing Process with ID <router-id>` precisely
  because there is no process id to print. The Learning Network capture's `PID 3` settles that the cell
  is the operator's number, not a constant: printing `1` would be a configuration nobody typed, the same
  objection that keeps `unassigned`/`unset` in `show ip interface brief`.
* **State - half derived.** `computeOspf()` does elect a role, but only across a **single cable with two
  speakers** (`engine/simulator.js`, the `aRole`/`bRole` block): higher router ID wins, the other end is
  the BDR, and a serial port gets `-` because its default network type is point-to-point. On a broadcast
  segment with three speakers there is no election to read, and a port with no neighbour at all is `DR`
  on a real box (Cisco Press sample) while this model has no record of having stood for election. The
  `DOWN` case (shut port) is the one state the model *does* know: `computeOspf()` drops the port, and
  `research/show-ospf-interface-shut-port.md` records the shut-port capture showing `DOWN`.
* **Nbrs F/C - half derived.** `dev.ospfNeighbors` counts adjacencies that **formed**, which is the `F`
  half; the `C` half counts neighbours *detected* (2-way), a state this model has no word for - an
  adjacency here is binary (formed or absent), because a Hello that disagrees on timers or area is
  recorded as a refusal (`dev.ospfRejected`) rather than as a neighbour in 2-WAY. So `F` is available
  and `C` would be `F` by construction, which is right on every capture in hand (`1/1`, `0/0`) and
  wrong exactly where the cell is interesting: a misconfigured neighbour that is heard but not adjacent.

## What changed

* `engine/cli.js`, `_showOspf()`, the `interface` branch: when the words after `interface` are not a
  port, the last one is tested against the keyword's own abbreviations (`b`, `bri`, `brie`, `brief`,
  any case). A match answers with a four-line refusal that names the view, prints the header at the
  vendor's widths, says the PID cell is the one no other view stands in for, and points at
  `show ip ospf interface [<port>]`. A device that genuinely has a port called `brief` still wins - the
  port table is consulted first, as `show interfaces` consults it for its own view words.
* `test/show-ip-ospf-interface-brief.test.js` (new, 16 checks): the refusal verbatim, the old
  `% No interface brief` gone, the header at the measured widths, the four abbreviations, a port named
  in front of the keyword, the three views that already worked (`show ip ospf interface`,
  `show ip ospf interface <port>`, `show ip ospf neighbour`) unchanged, and the port-named-`brief`
  precedence.
* `docs/CLI.md`: the paragraph that documented `% No interface brief on r1` as the console's answer now
  says what it answers and why.

## Still unresolved

1. **`C` (neighbours detected).** Needs a 2-WAY state, i.e. a neighbour that is heard but not adjacent,
   recorded instead of refused. `dev.ospfRejected` is the right place to grow it: a timer or area
   mismatch is already recorded with its port and its reason, and counting those as detected neighbours
   would make `F/C` read `0/1` where a box does. No capture in hand shows `0/1` on such a link, so the
   spelling of that row is unconfirmed.
2. **`State` on a segment with more than two speakers.** The election is per link and per pair; a third
   router on a switch fabric would need a segment-wide election before `DR`/`BDR`/`DROTHER` mean anything.
3. **`State` for a lone broadcast port.** The Cisco Press sample has `DR 0/0` on a port with no
   neighbour; this model cannot tell "became DR with nobody to talk to" from "never elected", so the
   cell is a guess it does not make.
4. **A shut port's row.** The howtonetwork capture lists a shut loopback as `DOWN 0/0`; with the table
   unimplemented this console can only say the port is shut, in the block view.

**What would settle them.** A paste of `show ip ospf interface brief` from a box with (a) three routers
on one VLAN, so the `DROTHER` spelling and the `1/1` count on a non-DR are visible, and (b) a neighbour
that is heard but stuck in 2-WAY (a Hello-interval mismatch), which is the only way to see `F/C` with
`F < C`. With either, cell 1 or 2 above stops being an inference. The PID and the table as a whole wait
on a modelling decision, not on evidence: until this console has `router ospf <process-id>`, the second
column has no value it can print honestly, and a `brief` table without the column a reader asked for is
not the vendor's table.
